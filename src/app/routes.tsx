/** Dashboard HTTP routes (Hono). */

import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { featuresNotInPlan, limitsFor } from '../core/plans';
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
import { billingConfigured, createCheckoutUrl, createPortalUrl, handleStripeEvent, verifyStripeSignature, type BillingEnv } from './billing';
import { addChannel, channelIdsForCheck, deleteChannel, getChannelRaw, listChannels, validateChannelUrl, type ChannelKind } from './channels';
import {
  acceptDrift,
  accountSignature,
  countActiveChecks,
  countChecks,
  createCheck,
  deleteCheck,
  enableBaseline,
  getCheck,
  listChecks,
  markDriftOptional,
  pauseCheck,
  proposeBaseline,
  recentIncidents,
  recentPings,
  resumeCheck,
  sparklines,
  updateCheck,
} from './checks';
import { gapsSince, latestGapEnd, type Check, type Db } from './db';
import { sendEmail, simpleHtml } from './email';
import { learnBaseline } from './evaluator';
import { cleanFolderName, createFolder, deleteFolder, folderBelongsTo, listFolders, renameFolder } from './folders';
import { CONCEPT_SLUG, GUIDES, renderGuide, renderTemplate } from './guides';
import { makeSender, type SenderEnv } from './sender';
import {
  BillingPage,
  ChannelsPage,
  CheckFormPage,
  CheckPage,
  ChecksPage,
  FoldersPage,
  gapAffects,
  GuidePage,
  GuidesIndexPage,
  LandingPage,
  LoginPage,
  MessagePage,
  VerifyPage,
} from './views';

export interface AppEnv extends SenderEnv, BillingEnv {
  HYPERDRIVE: { connectionString: string };
  INGEST: { fetch: (req: Request) => Promise<Response> };
  TOKEN_SECRET: string;
  PING_URL: string;
  DEFAULT_PLAN?: string;
  EVALUATOR_HEARTBEAT_URL?: string;
}

export type DbFactory = (env: AppEnv) => { db: Db; close: () => Promise<void> };

type HonoEnv = { Bindings: AppEnv; Variables: { db: Db; account: Account | null } };
type Ctx = Context<HonoEnv>;

const trimSlash = (s: string) => s.replace(/\/$/, '');

const NOTICES: Record<string, string> = {
  baseline_on: 'Volume alerts are on.',
  baseline_new: 'New baseline learned. Review it below, then switch alerts back on.',
  baseline_short: 'There is not enough clean history yet to learn a baseline. Try again in a few days.',
  drift_accepted: 'Done. The new payload shape is now the normal one.',
  drift_optional: 'Done. Those fields are now optional and will not trigger alerts.',
  resume_limit: 'This check cannot be resumed on your current plan.',
};

export function createApp(dbFactory: DbFactory) {
  const app = new Hono<HonoEnv>();

  app.get('/healthz', (c) => c.json({ ok: true, service: 'stepcanary-app' }));

  // Pings sent to the app hostname are handed straight to the ingest Worker (no database, no session).
  // Production customers use the dedicated ping hostname; this keeps local dev to a single port.
  app.all('/p/*', (c) => c.env.INGEST.fetch(c.req.raw));

  // Stripe calls this server-to-server: no cookie, no CSRF. Authenticity comes from the signature.
  app.post('/webhooks/stripe', async (c) => {
    const payload = await c.req.text();
    const ok = await verifyStripeSignature(payload, c.req.header('stripe-signature') ?? null, c.env.STRIPE_WEBHOOK_SECRET ?? '', Date.now());
    if (!ok) return c.json({ ok: false, error: 'bad_signature' }, 400);
    const { db, close } = dbFactory(c.env);
    try {
      const note = await handleStripeEvent(db, c.env, JSON.parse(payload), Date.now());
      return c.json({ ok: true, note });
    } catch (err) {
      // A 500 makes Stripe retry later, which is what we want for a transient failure.
      console.error('stripe_webhook_failed', String(err));
      return c.json({ ok: false }, 500);
    } finally {
      c.executionCtx.waitUntil(close().catch(() => {}));
    }
  });

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

  // The marketing site (stepcanary.com, www) is served by this same Worker. There it shows only
  // the public pages; everything else is sent to the app hostname, so sessions live in one place.
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const appHost = new URL(c.env.APP_URL).host;
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(url.host);
    const publicPage = url.pathname === '/' || url.pathname === '/guides' || url.pathname.startsWith('/guides/') || url.pathname.startsWith('/templates/');
    if (url.host !== appHost && !local && !publicPage) return c.redirect(`${trimSlash(c.env.APP_URL)}${url.pathname}${url.search}`, 302);
    await next();
  });

  // --- public -----------------------------------------------------------------------------------

  app.get('/', (c) => (c.get('account') ? c.redirect('/checks') : c.html(<LandingPage />)));

  app.get('/guides', (c) => c.html(<GuidesIndexPage account={c.get('account')} guides={GUIDES} checkId={c.req.query('check')} />));

  app.get('/guides/:slug', async (c) => {
    const account = c.get('account');
    const checkId = c.req.query('check');
    // Signed in and arriving from one of your own checks: fill in that check's real ping URL.
    const token = account && checkId ? (await getCheck(c.get('db'), account.id, checkId))?.token : undefined;
    const guide = renderGuide(c.req.param('slug'), c.env.PING_URL, token, checkId);
    if (!guide) return c.html(<MessagePage account={account} title="Guide not found" message="We do not have a guide at that address." />, 404);
    return c.html(<GuidePage account={account} title={guide.title} html={guide.html} personalized={!!token} concept={c.req.param('slug') === CONCEPT_SLUG} />);
  });

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

  // Importable templates (n8n workflow files). Public; pre-filled when opened from your own check.
  app.get('/templates/:platform/:file', async (c) => {
    const account = c.get('account');
    const checkId = c.req.query('check');
    const token = account && checkId ? (await getCheck(c.get('db'), account.id, checkId))?.token : undefined;
    const file = c.req.param('file');
    const body = renderTemplate(`${c.req.param('platform')}/${file}`, c.env.PING_URL, token);
    if (!body) return c.json({ error: 'not_found' }, 404);
    c.header('content-type', 'application/json; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${file}"`);
    c.header('cache-control', 'no-store');
    return c.body(body);
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

  for (const prefix of ['/checks', '/channels', '/folders', '/billing', '/sig']) {
    app.use(prefix, async (c, next) => (c.get('account') ? next() : c.redirect('/login')));
    app.use(`${prefix}/*`, async (c, next) => (c.get('account') ? next() : c.redirect('/login')));
  }

  // Open dashboard pages poll this and reload when anything they show has changed.
  app.get('/sig', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json({ sig: await accountSignature(c.get('db'), c.get('account')!.id) });
  });

  app.get('/checks', async (c) => {
    const db = c.get('db');
    const { account, limits } = page(c);
    const now = Date.now();
    const checks = await listChecks(db, account.id);
    return c.html(
      <ChecksPage
        account={account}
        checks={checks}
        sparks={await sparklines(db, account.id, now)}
        gaps={await gapsSince(db, now - 86_400_000)}
        latestGapEnd={await latestGapEnd(db)}
        limits={limits}
        folders={limits.folders ? await listFolders(db, account.id) : []}
        sig={await accountSignature(db, account.id)}
        now={now}
      />,
    );
  });

  const formPage = async (c: Ctx, extra: { check?: Check; errors?: string[]; status?: 200 | 400 } = {}) => {
    const db = c.get('db');
    const { account, limits } = page(c);
    return c.html(
      <CheckFormPage
        account={account}
        limits={limits}
        check={extra.check}
        channels={await listChannels(db, account.id)}
        selectedChannels={extra.check ? await channelIdsForCheck(db, extra.check.id) : undefined}
        folders={limits.folders ? await listFolders(db, account.id) : []}
        errors={extra.errors}
      />,
      extra.status ?? 200,
    );
  };

  app.get('/checks/new', (c) => formPage(c));

  app.post('/checks', async (c) => {
    const db = c.get('db');
    const { account, limits } = page(c);
    const form = (await c.req.parseBody({ all: true })) as FormData;
    const errors: string[] = [];
    if ((await countActiveChecks(db, account.id)) >= limits.maxChecks || (await countChecks(db, account.id)) >= limits.maxChecks * 2) {
      errors.push(`Your ${limits.label} plan includes ${limits.maxChecks} checks. Delete one or upgrade to add more.`);
    }
    const result = validateCheckForm(form, limits);
    if (!result.ok) errors.push(...result.errors);
    else if (result.value.folderId && !(await folderBelongsTo(db, account.id, result.value.folderId))) result.value.folderId = null;
    if (errors.length || !result.ok) return formPage(c, { errors, status: 400 });
    const id = await createCheck(db, account.id, result.value, c.env.TOKEN_SECRET);
    return c.redirect(`/checks/${id}?created=1`);
  });

  app.get('/checks/:id', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const db = c.get('db');
    const account = c.get('account')!;
    return c.html(
      <CheckPage
        account={account}
        check={check}
        pingUrl={`${trimSlash(c.env.PING_URL)}/p/${check.token}`}
        pings={await recentPings(db, check.id)}
        incidents={await recentIncidents(db, check.id)}
        gapAffected={gapAffects(check, await latestGapEnd(db))}
        created={c.req.query('created') === '1'}
        notice={NOTICES[c.req.query('notice') ?? '']}
        sig={await accountSignature(db, account.id)}
        now={Date.now()}
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
    return formPage(c, { check });
  });

  app.post('/checks/:id', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const db = c.get('db');
    const { account, limits } = page(c);
    const form = (await c.req.parseBody({ all: true })) as FormData;
    const result = validateCheckForm(form, limits);
    if (!result.ok) return formPage(c, { check, errors: result.errors, status: 400 });
    if (result.value.folderId && !(await folderBelongsTo(db, account.id, result.value.folderId))) result.value.folderId = null;
    await updateCheck(db, check, result.value, Date.now());
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
    const db = c.get('db');
    const { account, limits } = page(c);
    const blocked =
      featuresNotInPlan({ mode: check.cfg.mode, activeWindow: check.cfg.activeWindow, driftEnabled: check.driftEnabled }, limits).length > 0 ||
      (check.state.status === 'paused' && (await countActiveChecks(db, account.id)) >= limits.maxChecks);
    if (blocked) return c.redirect(`/checks/${check.id}?notice=resume_limit`);
    await resumeCheck(db, check, Date.now());
    return c.redirect(`/checks/${check.id}`);
  });

  app.post('/checks/:id/delete', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    await deleteCheck(c.get('db'), check);
    return c.redirect('/checks');
  });

  app.post('/checks/:id/baseline/enable', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const ok = await enableBaseline(c.get('db'), check, Date.now());
    return c.redirect(`/checks/${check.id}${ok ? '?notice=baseline_on' : ''}`);
  });

  app.post('/checks/:id/baseline/relearn', async (c) => {
    const check = await loadCheck(c);
    if (!check || check.cfg.mode !== 'volume') return notFound(c);
    const db = c.get('db');
    const now = Date.now();
    // Only the most recent 14 days: the point of relearning is to forget the old normal.
    const baseline = await learnBaseline(db, check, now, { recentOnly: true });
    if (!baseline) return c.redirect(`/checks/${check.id}?notice=baseline_short`);
    await proposeBaseline(db, check, baseline, now);
    return c.redirect(`/checks/${check.id}?notice=baseline_new`);
  });

  app.post('/checks/:id/drift/accept', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const ok = await acceptDrift(c.get('db'), check, Date.now());
    return c.redirect(`/checks/${check.id}${ok ? '?notice=drift_accepted' : ''}`);
  });

  app.post('/checks/:id/drift/optional', async (c) => {
    const check = await loadCheck(c);
    if (!check) return notFound(c);
    const ok = await markDriftOptional(c.get('db'), check, Date.now());
    return c.redirect(`/checks/${check.id}${ok ? '?notice=drift_optional' : ''}`);
  });

  // --- alert channels ---------------------------------------------------------------------------

  const channelsPage = async (c: Ctx, extra: { errors?: string[]; notice?: string; status?: 200 | 400 } = {}) => {
    const { account, limits } = page(c);
    return c.html(
      <ChannelsPage account={account} limits={limits} channels={await listChannels(c.get('db'), account.id)} errors={extra.errors} notice={extra.notice} />,
      extra.status ?? 200,
    );
  };

  app.get('/channels', (c) => channelsPage(c, { notice: c.req.query('added') ? 'Channel added to all your checks.' : undefined }));

  app.post('/channels', async (c) => {
    const { account, limits } = page(c);
    const form = await c.req.parseBody();
    const kind = String(form.kind ?? '') as ChannelKind;
    const errors: string[] = [];
    if (!limits.extraChannels) errors.push('Slack, Discord and webhook alerts are part of the Pro plan.');
    if (!['slack', 'discord', 'webhook'].includes(kind)) errors.push('Pick a channel type.');
    else {
      const problem = validateChannelUrl(kind, String(form.url ?? ''));
      if (problem) errors.push(problem);
    }
    if (!errors.length && !c.env.CHANNEL_KEY) errors.push('Channels cannot be added right now. Please contact support.');
    if (errors.length) return channelsPage(c, { errors, status: 400 });
    await addChannel(c.get('db'), account.id, kind, String(form.name ?? ''), String(form.url ?? ''), c.env.CHANNEL_KEY!);
    return c.redirect('/channels?added=1');
  });

  app.post('/channels/:id/delete', async (c) => {
    await deleteChannel(c.get('db'), c.get('account')!.id, c.req.param('id'));
    return c.redirect('/channels');
  });

  app.post('/channels/:id/test', async (c) => {
    const account = c.get('account')!;
    const channel = await getChannelRaw(c.get('db'), account.id, c.req.param('id'));
    if (!channel) return c.redirect('/channels');
    try {
      await makeSender(c.env)(channel, {
        event: 'down',
        subject: 'Test alert from StepCanary',
        body: 'This is a test. If you can read it, alerts to this channel are working.',
        link: `${trimSlash(c.env.APP_URL)}/channels`,
        checkId: 'test',
        checkName: 'Test alert',
        at: Date.now(),
        idempotencyKey: crypto.randomUUID(),
      });
      return channelsPage(c, { notice: 'Test alert sent. Check that it arrived.' });
    } catch (err) {
      console.error('channel_test_failed', String(err));
      return channelsPage(c, { errors: ['The test alert could not be delivered. Check the webhook URL is still valid.'], status: 400 });
    }
  });

  // --- client folders (Agency) ------------------------------------------------------------------

  const foldersPage = async (c: Ctx, errors?: string[]) => {
    const { account, limits } = page(c);
    if (!limits.folders) {
      return c.html(<MessagePage account={account} title="Client folders" message="Client folders and weekly client summaries are part of the Agency plan." />);
    }
    return c.html(<FoldersPage account={account} folders={await listFolders(c.get('db'), account.id)} errors={errors} />, errors ? 400 : 200);
  };

  app.get('/folders', (c) => foldersPage(c));

  app.post('/folders', async (c) => {
    const { account, limits } = page(c);
    if (!limits.folders) return foldersPage(c);
    const name = cleanFolderName(String((await c.req.parseBody()).name ?? ''));
    if (!name) return foldersPage(c, ['Give the folder a name of up to 80 characters.']);
    await createFolder(c.get('db'), account.id, name);
    return c.redirect('/folders');
  });

  app.post('/folders/:id', async (c) => {
    const name = cleanFolderName(String((await c.req.parseBody()).name ?? ''));
    if (!name) return foldersPage(c, ['Give the folder a name of up to 80 characters.']);
    await renameFolder(c.get('db'), c.get('account')!.id, c.req.param('id'), name);
    return c.redirect('/folders');
  });

  app.post('/folders/:id/delete', async (c) => {
    await deleteFolder(c.get('db'), c.get('account')!.id, c.req.param('id'));
    return c.redirect('/folders');
  });

  // --- billing ----------------------------------------------------------------------------------

  const billingPage = async (c: Ctx, extra: { errors?: string[]; notice?: string } = {}) => {
    const { account, limits } = page(c);
    return c.html(
      <BillingPage
        account={account}
        limits={limits}
        activeChecks={await countActiveChecks(c.get('db'), account.id)}
        configured={billingConfigured(c.env)}
        notice={extra.notice}
        errors={extra.errors}
      />,
      extra.errors ? 400 : 200,
    );
  };

  app.get('/billing', (c) =>
    billingPage(c, {
      notice: c.req.query('checkout') === 'success' ? 'Thank you! Your plan will update within a few seconds; refresh this page if it has not yet.' : undefined,
    }),
  );

  app.post('/billing/checkout', async (c) => {
    const account = c.get('account')!;
    const plan = String((await c.req.parseBody()).plan ?? '');
    if (plan !== 'pro' && plan !== 'agency') return billingPage(c, { errors: ['Pick a plan.'] });
    if (!billingConfigured(c.env)) return billingPage(c, { errors: ['Paid plans are not available yet.'] });
    // Existing subscribers change plan in the portal, so they can never end up with two subscriptions.
    if (account.stripeCustomerId && account.plan !== 'free') return c.redirect(await createPortalUrl(c.env, account.stripeCustomerId), 303);
    return c.redirect(await createCheckoutUrl(c.env, account, plan), 303);
  });

  app.post('/billing/portal', async (c) => {
    const account = c.get('account')!;
    if (!account.stripeCustomerId || !billingConfigured(c.env)) return c.redirect('/billing');
    return c.redirect(await createPortalUrl(c.env, account.stripeCustomerId), 303);
  });

  return app;
}
