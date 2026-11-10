/** Dashboard HTTP routes (Hono). */

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { limitsFor } from '../core/plans';
import { validateCheckForm, type FormData } from '../core/validate';
import { shapeKeys } from '../shared/fingerprint';
import {
  accountForSession,
  createLoginToken,
  destroySession,
  normalizeEmail,
  redeemLoginToken,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Account,
} from './auth';
import {
  countChecks,
  createCheck,
  deleteCheck,
  getCheck,
  listChecks,
  pauseCheck,
  recentIncidents,
  recentPings,
  resumeCheck,
  sparklines,
  updateCheck,
} from './checks';
import { gapsSince, latestGapEnd, type Db } from './db';
import { sendEmail, simpleHtml, type EmailEnv } from './email';
import { CheckFormPage, CheckPage, ChecksPage, gapAffects, LandingPage, LoginPage, MessagePage, VerifyPage } from './views';

export interface AppEnv extends EmailEnv {
  HYPERDRIVE: { connectionString: string };
  INGEST: { fetch: (req: Request) => Promise<Response> };
  TOKEN_SECRET: string;
  APP_URL: string;
  PING_URL: string;
  DEFAULT_PLAN?: string;
  EVALUATOR_HEARTBEAT_URL?: string;
}

export type DbFactory = (env: AppEnv) => { db: Db; close: () => Promise<void> };

type HonoEnv = { Bindings: AppEnv; Variables: { db: Db; account: Account | null } };
type Ctx = Context<HonoEnv>;

const trimSlash = (s: string) => s.replace(/\/$/, '');

export function createApp(dbFactory: DbFactory) {
  const app = new Hono<HonoEnv>();

  app.get('/healthz', (c) => c.json({ ok: true, service: 'stepcanary-app' }));

  // Pings sent to the app hostname are handed straight to the ingest Worker (no database, no session).
  // Production customers use the dedicated ping hostname; this keeps local dev to a single port.
  app.all('/p/*', (c) => c.env.INGEST.fetch(c.req.raw));

  app.use('*', secureHeaders());
  app.use('*', csrf());
  app.use('*', async (c, next) => {
    const { db, close } = dbFactory(c.env);
    c.set('db', db);
    try {
      c.set('account', await accountForSession(db, getCookie(c, SESSION_COOKIE), Date.now()));
      await next();
    } finally {
      c.executionCtx.waitUntil(close().catch(() => {}));
    }
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error('app_error', c.req.path, String(err));
    return c.html(<MessagePage title="Something went wrong" message="That did not work. Please try again in a moment." />, 500);
  });

  const page = (c: Ctx) => ({ account: c.get('account')!, limits: limitsFor(c.get('account')!.plan) });
  const loadCheck = (c: Ctx) => getCheck(c.get('db'), c.get('account')!.id, c.req.param('id') ?? '');
  const notFound = (c: Ctx) =>
    c.html(<MessagePage account={c.get('account')} title="Check not found" message="It may have been deleted." />, 404);

  // --- public -----------------------------------------------------------------------------------

  app.get('/', (c) => (c.get('account') ? c.redirect('/checks') : c.html(<LandingPage />)));

  app.get('/login', (c) => (c.get('account') ? c.redirect('/checks') : c.html(<LoginPage />)));

  app.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const email = normalizeEmail(String(form.email ?? ''));
    if (!email) return c.html(<LoginPage errors={['Enter a valid email address.']} />, 400);
    const now = Date.now();
    const token = await createLoginToken(c.get('db'), email, now);
    if (token) {
      const link = `${trimSlash(c.env.APP_URL)}/auth/verify?token=${encodeURIComponent(token)}`;
      const text = `Use this link to sign in to StepCanary. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.`;
      await sendEmail(c.env, {
        to: email,
        subject: 'Your StepCanary sign-in link',
        text,
        html: simpleHtml('Use the button below to sign in to StepCanary. It works once and expires in 15 minutes.\n\nIf you did not ask for this, you can ignore this email.', { url: link, label: 'Sign in' }),
      });
    }
    // Same answer whether or not we sent anything, so this page can't be used to probe addresses.
    return c.html(<LoginPage sent />);
  });

  // GET only shows a button; the token is redeemed on POST so email link-scanners can't use it up.
  app.get('/auth/verify', (c) => c.html(<VerifyPage token={c.req.query('token') ?? ''} />));

  app.post('/auth/verify', async (c) => {
    const form = await c.req.parseBody();
    const now = Date.now();
    const session = await redeemLoginToken(c.get('db'), String(form.token ?? ''), now, c.env.DEFAULT_PLAN ?? 'free');
    if (!session) return c.html(<VerifyPage token="" error />, 400);
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      secure: c.env.APP_URL.startsWith('https://'),
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.redirect('/checks');
  });

  app.post('/logout', async (c) => {
    await destroySession(c.get('db'), getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/');
  });

  // --- signed-in --------------------------------------------------------------------------------

  app.use('/checks/*', async (c, next) => (c.get('account') ? next() : c.redirect('/login')));
  app.use('/checks', async (c, next) => (c.get('account') ? next() : c.redirect('/login')));

  app.get('/checks', async (c) => {
    const db = c.get('db');
    const { account, limits } = page(c);
    const now = Date.now();
    const [checks, sparks, gaps, gapEnd] = await Promise.all([
      listChecks(db, account.id),
      sparklines(db, account.id, now),
      gapsSince(db, now - 86_400_000),
      latestGapEnd(db),
    ]);
    return c.html(<ChecksPage account={account} checks={checks} sparks={sparks} gaps={gaps} latestGapEnd={gapEnd} limits={limits} />);
  });

  app.get('/checks/new', (c) => c.html(<CheckFormPage {...page(c)} />));

  app.post('/checks', async (c) => {
    const db = c.get('db');
    const { account, limits } = page(c);
    const form = (await c.req.parseBody({ all: true })) as FormData;
    const errors: string[] = [];
    if ((await countChecks(db, account.id)) >= limits.maxChecks) {
      errors.push(`Your ${limits.label} plan includes ${limits.maxChecks} checks. Delete one or upgrade to add more.`);
    }
    const result = validateCheckForm(form, limits);
    if (!result.ok) errors.push(...result.errors);
    if (errors.length || !result.ok) return c.html(<CheckFormPage account={account} limits={limits} errors={errors} />, 400);
    const id = await createCheck(db, account.id, result.value, c.env.TOKEN_SECRET);
    return c.redirect(`/checks/${id}?created=1`);
  });

  app.get('/checks/:id', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const db = c.get('db');
    const [pings, incidents, gapEnd] = await Promise.all([recentPings(db, check.id), recentIncidents(db, check.id), latestGapEnd(db)]);
    return c.html(
      <CheckPage
        account={c.get('account')!}
        check={check}
        pingUrl={`${trimSlash(c.env.PING_URL)}/p/${check.token}`}
        pings={pings}
        incidents={incidents}
        gapAffected={gapAffects(check, gapEnd)}
        created={c.req.query('created') === '1'}
      />,
    );
  });

  // Polled by the "Listening for your first ping..." panel.
  app.get('/checks/:id/listen', async (c) => {
    const check = await loadCheck(c);
    if (!check) return c.json({ connected: false }, 404);
    const s = check.state;
    const at = s.lastPingAt ?? s.lastFailAt ?? s.lastStartAt;
    c.header('cache-control', 'no-store');
    return c.json({ connected: at != null, at, keys: check.lastShape ? shapeKeys(check.lastShape) : [] });
  });

  app.get('/checks/:id/edit', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    return c.html(<CheckFormPage {...page(c)} check={check} />);
  });

  app.post('/checks/:id', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const { account, limits } = page(c);
    const form = (await c.req.parseBody({ all: true })) as FormData;
    const result = validateCheckForm(form, limits);
    if (!result.ok) return c.html(<CheckFormPage account={account} limits={limits} check={check} errors={result.errors} />, 400);
    await updateCheck(c.get('db'), check, result.value, Date.now());
    return c.redirect(`/checks/${check.id}`);
  });

  app.post('/checks/:id/pause', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    await pauseCheck(c.get('db'), check, Date.now());
    return c.redirect(`/checks/${check.id}`);
  });

  app.post('/checks/:id/resume', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    await resumeCheck(c.get('db'), check, Date.now());
    return c.redirect(`/checks/${check.id}`);
  });

  app.post('/checks/:id/delete', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    await deleteCheck(c.get('db'), check);
    return c.redirect('/checks');
  });

  return app;
}
