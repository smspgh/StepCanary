/** Server-rendered dashboard. No client framework: one small inline script handles the niceties. */

import type { Child, FC } from 'hono/jsx';
import { describeExpectation, formatDuration } from '../core/describe';
import type { CheckConfig, CheckStatus } from '../core/evaluate';
import type { PlanLimits } from '../core/plans';
import { shapeKeys } from '../shared/fingerprint';
import { FLAG_MALFORMED, FLAG_TOO_LARGE } from '../shared/messages';
import type { Account } from './auth';
import type { IncidentRow, PingRow } from './checks';
import type { Check, GapRow } from './db';

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1c2128;--muted:#667085;--line:#e3e6ea;--accent:#1f6feb;
--up:#1a7f37;--late:#b7791f;--down:#cf222e;--new:#6e7781;--paused:#6e7781}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:960px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:16px}
.brand{font-weight:700;color:var(--text);font-size:17px}.spacer{flex:1}.muted{color:var(--muted)}.small{font-size:13px}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:#fff}
.badge.up{background:var(--up)}.badge.late{background:var(--late)}.badge.down{background:var(--down)}
.badge.new,.badge.paused{background:var(--new)}.badge.gap{background:#fff;color:var(--late);border:1px solid var(--late)}
.btn{display:inline-block;border:1px solid var(--line);background:var(--card);color:var(--text);padding:7px 13px;border-radius:7px;font:inherit;cursor:pointer}
.btn:hover{text-decoration:none;border-color:#c5cad1}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--down)}form.inline{display:inline}
label{display:block;font-weight:600;margin:14px 0 4px}
input[type=text],input[type=email],input[type=number],input[type=time],select{font:inherit;padding:8px 10px;border:1px solid #c5cad1;border-radius:7px;background:#fff;max-width:100%}
input[type=text],input[type=email]{width:100%}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row input[type=number]{width:110px}
.hint{color:var(--muted);font-size:13px;margin-top:4px}.errors{background:#fff1f0;border:1px solid #f3c1bd;color:#a40e26;border-radius:8px;padding:10px 14px;margin-bottom:16px}
.banner{background:#fff8e6;border:1px solid #f0d58c;border-radius:8px;padding:10px 14px;margin-bottom:16px}
.url{font-family:ui-monospace,Consolas,monospace;font-size:13px;background:#f1f3f5;border:1px solid var(--line);border-radius:7px;padding:8px 10px;word-break:break-all;flex:1}
.listen{border:2px dashed #c5cad1;border-radius:10px;padding:18px;text-align:center}.listen.ok{border:2px solid var(--up);background:#f0faf2}
.pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);margin-right:8px;animation:p 1.2s infinite}
@keyframes p{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}
code,.key{font-family:ui-monospace,Consolas,monospace;font-size:13px}.key{display:inline-block;background:#eef2f6;border-radius:5px;padding:1px 7px;margin:2px}
details{border-top:1px solid var(--line);padding:10px 0}details:first-of-type{border-top:0}summary{cursor:pointer;font-weight:600}
dl{display:grid;grid-template-columns:170px 1fr;gap:6px 12px;margin:10px 0 0}dt{color:var(--muted)}dd{margin:0}
.shot{border:1px dashed #c5cad1;border-radius:8px;padding:14px;color:var(--muted);font-size:13px;text-align:center;margin-top:10px}
.spark rect{fill:#9db7e8}.days label{display:inline-block;font-weight:400;margin:0 10px 0 0}
`;

const JS = `
(function(){
function rel(ms){var s=Math.round(ms/1000);if(s<0)s=0;if(s<60)return s+'s ago';var m=Math.round(s/60);if(m<60)return m+' min ago';
var h=Math.round(m/60);if(h<48)return h+' h ago';return Math.round(h/24)+' days ago'}
function times(){document.querySelectorAll('time[datetime]').forEach(function(el){var d=new Date(el.getAttribute('datetime'));
el.title=d.toLocaleString();el.textContent=el.hasAttribute('data-abs')?d.toLocaleString():rel(Date.now()-d.getTime())})}
times();setInterval(times,30000);
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t},1200)})})});
var tz=document.querySelector('input[name=timezone]');if(tz&&!tz.value){try{tz.value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){tz.value='UTC'}}
function modes(){var r=document.querySelector('input[name=mode]:checked');if(!r)return;
document.querySelectorAll('[data-mode]').forEach(function(el){el.style.display=el.getAttribute('data-mode')===r.value?'':'none'})}
document.querySelectorAll('input[name=mode]').forEach(function(r){r.addEventListener('change',modes)});modes();
var w=document.querySelector('input[name=window_enabled]'),wf=document.getElementById('window-fields');
function win(){if(w&&wf)wf.style.display=w.checked?'':'none'}if(w){w.addEventListener('change',win);win()}
document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.getAttribute('data-confirm')))e.preventDefault()})});
var L=document.getElementById('listener');
if(L&&L.getAttribute('data-connected')!=='1'){var poll=function(){fetch(L.getAttribute('data-url'),{headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(j){
if(!j.connected){setTimeout(poll,2000);return}
L.className='listen ok';var keys=(j.keys||[]).map(function(k){var s=document.createElement('span');s.className='key';s.textContent=k;return s});
L.textContent='';var h=document.createElement('strong');h.textContent='Connected! First ping received';L.appendChild(h);
var p=document.createElement('div');p.className='hint';p.textContent=keys.length?'Detected payload keys:':'No payload fields were sent (that is fine - the ping itself is what counts).';L.appendChild(p);
var box=document.createElement('div');keys.forEach(function(k){box.appendChild(k)});L.appendChild(box);
}).catch(function(){setTimeout(poll,4000)})};poll()}
})();
`;

export const Layout: FC<{ title: string; account?: Account | null; children?: Child }> = ({ title, account, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · StepCanary</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <div class="bar">
          <a class="brand" href="/">StepCanary</a>
          <span class="spacer" />
          {account ? (
            <>
              <span class="muted small">{account.email}</span>
              <form class="inline" method="post" action="/logout">
                <button class="btn" type="submit">Sign out</button>
              </form>
            </>
          ) : (
            <a class="btn" href="/login">Sign in</a>
          )}
        </div>
      </header>
      <main>{children}</main>
      <script dangerouslySetInnerHTML={{ __html: JS }} />
    </body>
  </html>
);

const Time: FC<{ at: number | null; abs?: boolean }> = ({ at, abs }) =>
  at == null ? <span class="muted">never</span> : <time datetime={new Date(at).toISOString()} {...(abs ? { 'data-abs': '' } : {})}>{new Date(at).toISOString()}</time>;

const STATUS_LABEL: Record<CheckStatus, string> = { new: 'new', up: 'up', late: 'late', down: 'down', paused: 'paused' };

const Status: FC<{ status: CheckStatus }> = ({ status }) => <span class={`badge ${status}`}>{STATUS_LABEL[status]}</span>;

export const Sparkline: FC<{ series?: number[] }> = ({ series }) => {
  const data = series ?? [];
  const max = Math.max(1, ...data);
  const H = 24;
  return (
    <svg class="spark" width="168" height={H} viewBox={`0 0 168 ${H}`} role="img" aria-label="Pings per hour, last 7 days">
      <line x1="0" y1={H - 0.5} x2="168" y2={H - 0.5} stroke="#e3e6ea" />
      {data.map((v, i) => (v > 0 ? <rect x={i} y={H - Math.max(2, (v / max) * H)} width="1" height={Math.max(2, (v / max) * H)} /> : null))}
    </svg>
  );
};

const Errors: FC<{ errors?: string[] }> = ({ errors }) =>
  errors && errors.length ? (
    <div class="errors">
      {errors.map((e) => (
        <div>{e}</div>
      ))}
    </div>
  ) : null;

const GAP_REASON: Record<string, string> = {
  evaluator_missed: 'our checker missed some runs',
  evaluator_error: 'our checker hit an error',
  ingest_stalled: 'our ping pipeline was not keeping up',
  ingest_delay: 'pings were delayed on our side',
};

const GapBanner: FC<{ gaps: GapRow[] }> = ({ gaps }) =>
  gaps.length === 0 ? null : (
    <div class="banner">
      <strong>Monitoring gap.</strong> For a short time we could not vouch for our own monitoring, so we held back "down" alerts rather than
      risk a false alarm. Timers restarted when the gap ended.
      <ul>
        {gaps.slice(0, 3).map((g) => (
          <li>
            <Time at={g.startedAt} abs /> → <Time at={g.endedAt} abs /> ({GAP_REASON[g.reason] ?? g.reason})
          </li>
        ))}
      </ul>
    </div>
  );

/** A gap, not a ping, is what this check's timer is currently counting from. */
export function gapAffects(check: Check, latestGapEnd: number | null): boolean {
  if (latestGapEnd == null || (check.state.status !== 'up' && check.state.status !== 'late')) return false;
  return latestGapEnd > Math.max(check.state.lastPingAt ?? 0, check.state.clockResetAt ?? 0);
}

// --- pages --------------------------------------------------------------------------------------

export const LandingPage: FC = () => (
  <Layout title="Know when your automations stop">
    <div class="card">
      <h1>Know the moment a Zap, scenario or workflow stops running.</h1>
      <p>
        Add one HTTP step to your automation. If the pings stop, StepCanary tells you in plain English – before your customer does. Works
        with Zapier, Make, n8n and Pipedream.
      </p>
      <a class="btn primary" href="/login">Get started free</a>
    </div>
  </Layout>
);

export const LoginPage: FC<{ sent?: boolean; errors?: string[] }> = ({ sent, errors }) => (
  <Layout title="Sign in">
    <div class="card" style="max-width:440px;margin:40px auto">
      <h1>Sign in</h1>
      {sent ? (
        <p>
          <strong>Check your email.</strong> If that address can sign in, we have sent it a link. It works once and expires in 15 minutes.
        </p>
      ) : (
        <form method="post" action="/login">
          <Errors errors={errors} />
          <p class="muted">No password needed. We email you a sign-in link.</p>
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" required autofocus autocomplete="email" />
          <p>
            <button class="btn primary" type="submit">Email me a sign-in link</button>
          </p>
        </form>
      )}
    </div>
  </Layout>
);

export const VerifyPage: FC<{ token: string; error?: boolean }> = ({ token, error }) => (
  <Layout title="Sign in">
    <div class="card" style="max-width:440px;margin:40px auto">
      {error ? (
        <>
          <h1>That link has expired</h1>
          <p>Sign-in links work once and last 15 minutes.</p>
          <a class="btn primary" href="/login">Send me a new link</a>
        </>
      ) : (
        <form method="post" action="/auth/verify">
          <h1>Almost there</h1>
          <input type="hidden" name="token" value={token} />
          <button class="btn primary" type="submit">Sign in to StepCanary</button>
        </form>
      )}
    </div>
  </Layout>
);

export const ChecksPage: FC<{
  account: Account;
  checks: Check[];
  sparks: Map<string, number[]>;
  gaps: GapRow[];
  latestGapEnd: number | null;
  limits: PlanLimits;
}> = ({ account, checks, sparks, gaps, latestGapEnd, limits }) => (
  <Layout title="Checks" account={account}>
    <div class="row" style="margin-bottom:16px">
      <h1 style="margin:0">Checks</h1>
      <span class="muted small">
        {checks.length} of {limits.maxChecks} on the {limits.label} plan
      </span>
      <span class="spacer" style="flex:1" />
      <a class="btn primary" href="/checks/new">New check</a>
    </div>
    <GapBanner gaps={gaps} />
    <div class="card" style="padding:4px 12px">
      {checks.length === 0 ? (
        <p>
          No checks yet. <a href="/checks/new">Create your first check</a> – it takes about two minutes.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Automation</th>
              <th>Last ping</th>
              <th>Last 7 days</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr>
                <td>
                  <Status status={c.state.status} />{' '}
                  {gapAffects(c, latestGapEnd) ? <span class="badge gap" title="Timer restarted after a monitoring gap on our side">monitoring gap</span> : null}
                </td>
                <td>
                  <a href={`/checks/${c.id}`}>{c.name}</a>
                  {c.payloadWarning ? <div class="small" style="color:var(--late)">{warningLabel(c.payloadWarning)}</div> : null}
                </td>
                <td>
                  <Time at={c.state.lastPingAt} />
                </td>
                <td>
                  <Sparkline series={sparks.get(c.id)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </Layout>
);

function warningLabel(w: string): string {
  if (w === 'malformed') return 'Malformed payload: the last ping’s JSON could not be read (the ping itself still counted).';
  if (w === 'too_large') return 'Payload too large to inspect (over 256 KB). The ping itself still counted.';
  return w;
}

function splitDuration(seconds: number | null, fallback: [number, string]): [number, string] {
  if (!seconds) return fallback;
  if (seconds % 86400 === 0) return [seconds / 86400, 'days'];
  if (seconds % 3600 === 0) return [seconds / 3600, 'hours'];
  return [Math.round(seconds / 60), 'minutes'];
}

const UnitSelect: FC<{ name: string; value: string }> = ({ name, value }) => (
  <select name={name}>
    {['minutes', 'hours', 'days'].map((u) => (
      <option value={u} selected={u === value}>
        {u}
      </option>
    ))}
  </select>
);

const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const DAYS: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

export const CheckFormPage: FC<{
  account: Account;
  limits: PlanLimits;
  check?: { id: string; name: string; cfg: CheckConfig };
  errors?: string[];
}> = ({ account, limits, check, errors }) => {
  const cfg = check?.cfg;
  const [iv, iu] = splitDuration(cfg?.intervalSeconds ?? null, [1, 'hours']);
  const [gv, gu] = splitDuration(cfg?.graceSeconds ?? null, [10, 'minutes']);
  const mode = cfg?.mode ?? 'interval';
  const w = cfg?.activeWindow ?? null;
  return (
    <Layout title={check ? `Edit ${check.name}` : 'New check'} account={account}>
      <h1>{check ? 'Edit check' : 'New check'}</h1>
      <form class="card" method="post" action={check ? `/checks/${check.id}` : '/checks'}>
        <Errors errors={errors} />
        <label for="name">Which automation is this?</label>
        <input id="name" name="name" type="text" maxlength={100} required value={check?.name ?? ''} placeholder="e.g. New lead → CRM" />

        <label>When should it check in?</label>
        <div class="row">
          <label style="font-weight:400;margin:0">
            <input type="radio" name="mode" value="interval" checked={mode === 'interval'} /> At least every…
          </label>
          <label style="font-weight:400;margin:0">
            <input type="radio" name="mode" value="schedule" checked={mode === 'schedule'} disabled={!limits.scheduleMode} /> At set times
            (schedule){limits.scheduleMode ? '' : ' – Pro'}
          </label>
        </div>

        <div data-mode="interval">
          <label>Expect at least one ping every</label>
          <div class="row">
            <input type="number" name="interval_value" min="1" step="1" value={String(iv)} />
            <UnitSelect name="interval_unit" value={iu} />
          </div>
          <label style="font-weight:400">
            <input type="checkbox" name="window_enabled" value="1" checked={!!w} disabled={!limits.activeWindows} /> Only count time during
            certain hours (active window){limits.activeWindows ? '' : ' – Pro'}
          </label>
          <div id="window-fields">
            <div class="days">
              {DAYS.map(([n, label]) => (
                <label>
                  <input type="checkbox" name="window_days" value={String(n)} checked={w ? w.days.includes(n) : n <= 5} /> {label}
                </label>
              ))}
            </div>
            <div class="row" style="margin-top:8px">
              from <input type="time" name="window_start" value={clock(w?.start ?? 540)} /> to{' '}
              <input type="time" name="window_end" value={clock(Math.min(w?.end ?? 1080, 1439))} />
            </div>
            <div class="hint">Outside these hours the timer is paused, so quiet nights and weekends never raise an alarm.</div>
          </div>
        </div>

        <div data-mode="schedule">
          <label for="cron">Schedule (cron format)</label>
          <input id="cron" name="cron" type="text" value={cfg?.cron ?? ''} placeholder="0 9 * * 1-5" />
          <div class="hint">
            Five fields: minute, hour, day of month, month, day of week. <code>0 9 * * 1-5</code> means 09:00 on weekdays.
          </div>
        </div>

        <label>Grace period</label>
        <div class="row">
          <input type="number" name="grace_value" min="1" step="1" value={String(gv)} />
          <UnitSelect name="grace_unit" value={gu} />
        </div>
        <div class="hint">How long we wait after a ping is due before alerting you.</div>

        <label for="timezone">Timezone</label>
        <input id="timezone" name="timezone" type="text" value={cfg?.timezone ?? ''} placeholder="Europe/London" />

        <p style="margin-top:20px">
          <button class="btn primary" type="submit">{check ? 'Save changes' : 'Create check'}</button>{' '}
          <a class="btn" href={check ? `/checks/${check.id}` : '/checks'}>Cancel</a>
        </p>
      </form>
    </Layout>
  );
};

const Shot: FC<{ label: string }> = ({ label }) => <div class="shot">[ Screenshot placeholder: {label} ]</div>;

const PlatformSettings: FC<{ url: string }> = ({ url }) => {
  const body = '{"status":"ok"}';
  return (
    <div class="card">
      <h2 style="margin-top:0">Exact settings to copy</h2>
      <details open>
        <summary>Zapier</summary>
        <dl>
          <dt>Add step</dt><dd>Webhooks by Zapier (last step of the Zap)</dd>
          <dt>Event</dt><dd>POST</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Payload Type</dt><dd>json</dd>
          <dt>Data</dt><dd>Optional. Add fields you want watched, e.g. <code>email</code> → the mapped email.</dd>
          <dt>Everything else</dt><dd>Leave as it is, then click <strong>Test step</strong>.</dd>
        </dl>
        <Shot label="Zapier – Webhooks by Zapier POST step" />
      </details>
      <details>
        <summary>Make</summary>
        <dl>
          <dt>Add module</dt><dd>HTTP → Make a request (last module of the scenario)</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Method</dt><dd>POST</dd>
          <dt>Body type</dt><dd>Raw</dd>
          <dt>Content type</dt><dd>JSON (application/json)</dd>
          <dt>Request content</dt><dd><code>{body}</code></dd>
          <dt>Then</dt><dd>Click <strong>Run once</strong>.</dd>
        </dl>
        <Shot label="Make – HTTP “Make a request” module" />
      </details>
      <details>
        <summary>n8n</summary>
        <dl>
          <dt>Add node</dt><dd>HTTP Request (last node of the workflow)</dd>
          <dt>Method</dt><dd>POST</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Send Body</dt><dd>On · Body Content Type: JSON · Specify Body: Using JSON</dd>
          <dt>JSON</dt><dd><code>{body}</code></dd>
          <dt>Then</dt><dd>Click <strong>Execute step</strong>.</dd>
        </dl>
        <Shot label="n8n – HTTP Request node" />
      </details>
      <details>
        <summary>Pipedream</summary>
        <dl>
          <dt>Add step</dt><dd>HTTP / Webhook → Send any HTTP Request (last step)</dd>
          <dt>Method</dt><dd>POST</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Body</dt><dd>Content type application/json, <code>{body}</code></dd>
          <dt>Then</dt><dd>Click <strong>Test</strong>.</dd>
        </dl>
        <Shot label="Pipedream – Send any HTTP Request step" />
      </details>
      <p class="hint">
        Advanced: send to <code>{url}/fail</code> from an error path to report a failure immediately, or <code>{url}/start</code> when a run
        begins.
      </p>
    </div>
  );
};

export const CheckPage: FC<{
  account: Account;
  check: Check;
  pingUrl: string;
  pings: PingRow[];
  incidents: IncidentRow[];
  gapAffected: boolean;
  created?: boolean;
}> = ({ account, check, pingUrl, pings, incidents, gapAffected, created }) => {
  const s = check.state;
  const connected = s.lastPingAt != null || s.lastStartAt != null || s.lastFailAt != null;
  const keys = check.lastShape ? shapeKeys(check.lastShape) : [];
  return (
    <Layout title={check.name} account={account}>
      <p class="small">
        <a href="/checks">← All checks</a>
      </p>
      <div class="row" style="margin-bottom:16px">
        <h1 style="margin:0">{check.name}</h1>
        <Status status={s.status} />
        {gapAffected ? <span class="badge gap">monitoring gap</span> : null}
        <span style="flex:1" />
        <a class="btn" href={`/checks/${check.id}/edit`}>Edit</a>
        {s.status === 'paused' ? (
          <form class="inline" method="post" action={`/checks/${check.id}/resume`}>
            <button class="btn" type="submit">Resume</button>
          </form>
        ) : (
          <form class="inline" method="post" action={`/checks/${check.id}/pause`}>
            <button class="btn" type="submit">Pause</button>
          </form>
        )}
        <form class="inline" method="post" action={`/checks/${check.id}/delete`} data-confirm="Delete this check and its history? This cannot be undone.">
          <button class="btn danger" type="submit">Delete</button>
        </form>
      </div>

      {created ? <div class="banner">Check created. Now add the ping step to your automation – this page updates by itself when the first ping arrives.</div> : null}
      {check.payloadWarning ? <div class="banner">{warningLabel(check.payloadWarning)}</div> : null}
      {gapAffected ? (
        <div class="banner">
          We had a monitoring gap on our side since this check’s last ping, so its timer restarted when the gap ended. No action needed.
        </div>
      ) : null}

      <div class="card">
        <strong>Ping URL</strong>
        <div class="row" style="margin-top:6px">
          <span class="url">{pingUrl}</span>
          <button class="btn" type="button" data-copy={pingUrl}>Copy</button>
        </div>
        <p class="hint">We expect {describeExpectation(check.cfg)}.</p>
        <div id="listener" class={connected ? 'listen ok' : 'listen'} data-url={`/checks/${check.id}/listen`} data-connected={connected ? '1' : '0'} style="margin-top:12px">
          {connected ? (
            <>
              <strong>Connected.</strong> Last ping <Time at={s.lastPingAt ?? s.lastFailAt ?? s.lastStartAt} />.
              <div class="hint">{keys.length ? 'Detected payload keys:' : 'No payload fields detected on the last ping.'}</div>
              <div>
                {keys.map((k) => (
                  <span class="key">{k}</span>
                ))}
              </div>
            </>
          ) : (
            <>
              <span class="pulse" />
              <strong>Listening for your first ping…</strong>
              <div class="hint">Add the step below, then press “Test step” in your automation tool. No alerts are sent until the first ping arrives.</div>
            </>
          )}
        </div>
      </div>

      <PlatformSettings url={pingUrl} />

      <div class="card">
        <h2 style="margin-top:0">Recent pings</h2>
        {pings.length === 0 ? (
          <p class="muted">Nothing yet.</p>
        ) : (
          <table>
            <tbody>
              {pings.map((p) => (
                <tr>
                  <td><Time at={p.at} abs /></td>
                  <td>{p.kind === 'ok' ? 'success' : p.kind === 'fail' ? 'failure reported' : 'run started'}</td>
                  <td class="muted small">
                    {p.flags & FLAG_MALFORMED ? 'malformed payload ' : ''}
                    {p.flags & FLAG_TOO_LARGE ? 'payload too large ' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card">
        <h2 style="margin-top:0">Incidents</h2>
        {incidents.length === 0 ? (
          <p class="muted">None. </p>
        ) : (
          <table>
            <tbody>
              {incidents.map((i) => (
                <tr>
                  <td>{i.reason === 'reported_failure' ? 'Failure reported' : 'Stopped checking in'}</td>
                  <td><Time at={i.openedAt} abs /></td>
                  <td>
                    {i.resolvedAt ? `recovered after ${formatDuration((i.resolvedAt - i.openedAt) / 1000)}` : <span class="badge down">ongoing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
};

export const MessagePage: FC<{ account?: Account | null; title: string; message: string }> = ({ account, title, message }) => (
  <Layout title={title} account={account}>
    <div class="card">
      <h1>{title}</h1>
      <p>{message}</p>
      <a class="btn" href="/checks">Back to checks</a>
    </div>
  </Layout>
);
