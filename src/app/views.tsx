/** Server-rendered dashboard. No client framework: one small inline script handles the niceties. */

import type { Child, FC } from 'hono/jsx';
import { describeExpectation, formatDuration } from '../core/describe';
import { describeChanges, diffShape } from '../core/drift';
import type { CheckConfig, CheckStatus } from '../core/evaluate';
import { limitsFor, PLANS, type PlanLimits } from '../core/plans';
import { baselineRows, learningPeriod, learningReadyAt, LEARNING_DAYS } from '../core/volume';
import { shapeKeys } from '../shared/fingerprint';
import { FLAG_MALFORMED, FLAG_THROTTLED, FLAG_TOO_LARGE } from '../shared/messages';
import type { Account } from './auth';
import { KIND_LABEL, type Channel } from './channels';
import type { IncidentRow, PingRow } from './checks';
import type { Check, GapRow } from './db';
import type { Folder } from './folders';

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1c2128;--muted:#667085;--line:#e3e6ea;--accent:#1f6feb;
--up:#1a7f37;--late:#b7791f;--down:#cf222e;--new:#6e7781;--paused:#6e7781}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line)}
.bar{max-width:960px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{font-weight:700;color:var(--text);font-size:17px}.spacer{flex:1}.muted{color:var(--muted)}.small{font-size:13px}
nav a{color:var(--text);margin-right:14px}nav a.on{font-weight:600;color:var(--accent)}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:16px;margin:28px 0 10px}h3{font-size:14px;margin:18px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
.badge.up{background:var(--up)}.badge.late{background:var(--late)}.badge.down{background:var(--down)}
.badge.new,.badge.paused{background:var(--new)}.badge.note{background:#fff;color:var(--late);border:1px solid var(--late)}
.btn{display:inline-block;border:1px solid var(--line);background:var(--card);color:var(--text);padding:7px 13px;border-radius:7px;font:inherit;cursor:pointer}
.btn:hover{text-decoration:none;border-color:#c5cad1}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--down)}.btn[disabled]{opacity:.5;cursor:default}form.inline{display:inline}
label{display:block;font-weight:600;margin:14px 0 4px}label.plain{font-weight:400;margin:6px 0}
input[type=text],input[type=email],input[type=url],input[type=number],input[type=time],select{font:inherit;padding:8px 10px;border:1px solid #c5cad1;border-radius:7px;background:#fff;max-width:100%}
input[type=text],input[type=email],input[type=url]{width:100%}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row input[type=number]{width:110px}
.hint{color:var(--muted);font-size:13px;margin-top:4px}.errors{background:#fff1f0;border:1px solid #f3c1bd;color:#a40e26;border-radius:8px;padding:10px 14px;margin-bottom:16px}
.banner{background:#fff8e6;border:1px solid #f0d58c;border-radius:8px;padding:10px 14px;margin-bottom:16px}
.banner.ok{background:#f0faf2;border-color:#b7dfc0}
.url{font-family:ui-monospace,Consolas,monospace;font-size:13px;background:#f1f3f5;border:1px solid var(--line);border-radius:7px;padding:8px 10px;word-break:break-all;flex:1}
.listen{border:2px dashed #c5cad1;border-radius:10px;padding:18px;text-align:center}.listen.ok{border:2px solid var(--up);background:#f0faf2}
.pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);margin-right:8px;animation:p 1.2s infinite}
@keyframes p{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}
code,.key{font-family:ui-monospace,Consolas,monospace;font-size:13px}.key{display:inline-block;background:#eef2f6;border-radius:5px;padding:1px 7px;margin:2px}
details{border-top:1px solid var(--line);padding:10px 0}details:first-of-type{border-top:0}summary{cursor:pointer;font-weight:600}
dl{display:grid;grid-template-columns:170px 1fr;gap:6px 12px;margin:10px 0 0}dt{color:var(--muted)}dd{margin:0}
.shot{border:1px dashed #c5cad1;border-radius:8px;padding:14px;color:var(--muted);font-size:13px;text-align:center;margin-top:10px}
.spark rect{fill:#9db7e8}.days label{display:inline-block;font-weight:400;margin:0 10px 0 0}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.plans .card{margin:0}.plans ul{padding-left:18px;margin:8px 0 14px}
.price{font-size:22px;font-weight:700}
.term{color:inherit;border-bottom:1px dotted currentColor;cursor:help}.term:hover{text-decoration:none;color:var(--accent)}
.explain{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:14px 0}.explain div{background:#f6f7f9;border-radius:8px;padding:12px}.explain p{margin:6px 0 0;color:#3d4756;font-size:14px}
main.wide{max-width:none;padding:0}
section{padding:56px 16px}section.band{background:#eef1f5}.inner{max-width:960px;margin:0 auto}.inner.narrow{max-width:720px}
section h2{font-size:24px;margin:0 0 22px;text-align:center}
.hero{text-align:center;padding:72px 16px 56px}.hero h1{font-size:40px;line-height:1.15;margin:0 auto 16px;max-width:760px}
.eyebrow{color:var(--accent);font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.06em;margin:0 0 12px}
.lede{font-size:18px;color:#3d4756;max-width:640px;margin:0 auto 22px}.btn.big{padding:11px 20px;font-size:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.grid .card{margin:0}.grid .card p{margin:8px 0 0;color:#3d4756}.grid.two{grid-template-columns:repeat(auto-fit,minmax(380px,1fr))}
.step{padding:4px 8px}.step p{color:#3d4756;margin:6px 0 0}.num{display:inline-flex;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;align-items:center;justify-content:center;margin-right:8px}
.mock{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;max-width:680px;margin:32px auto 10px;box-shadow:0 6px 24px rgba(16,24,40,.08);text-align:left}
.mock-head{border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:6px;display:flex;flex-direction:column;gap:2px}
details.faq{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:10px}details.faq p{margin:10px 0 2px;color:#3d4756}
footer{padding:24px 16px;color:var(--muted);font-size:13px;text-align:center}
a.tile{display:block;color:var(--text)}a.tile:hover{text-decoration:none;border-color:var(--accent)}
.guide h1{font-size:24px}.guide h2{font-size:18px;margin-top:30px;padding-top:18px;border-top:1px solid var(--line)}.guide li{margin:6px 0}
.guide table{margin:12px 0}.guide td:first-child{white-space:nowrap}.guide td code{word-break:break-all}
pre{background:#f1f3f5;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}pre code{font-size:13px}
@media(max-width:600px){.hero h1{font-size:30px}.guide td:first-child{white-space:normal}}
`;

const JS = `
(function(){
function rel(ms){var s=Math.round(ms/1000);if(s<0)s=0;if(s<60)return s+'s ago';var m=Math.round(s/60);if(m<60)return m+' min ago';
var h=Math.round(m/60);if(h<48)return h+' h ago';return Math.round(h/24)+' days ago'}
function times(){document.querySelectorAll('time[datetime]').forEach(function(el){var d=new Date(el.getAttribute('datetime'));
el.title=d.toLocaleString();if(el.hasAttribute('data-date')){el.textContent=d.toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'});return}
el.textContent=el.hasAttribute('data-abs')?d.toLocaleString():rel(Date.now()-d.getTime())})}
times();setInterval(times,30000);
document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){
navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function(){var t=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=t},1200)})})});
var tz=document.querySelector('input[name=timezone]');if(tz&&!tz.value){try{tz.value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){tz.value='UTC'}}
function modes(){var r=document.querySelector('input[name=mode]:checked');if(!r)return;
document.querySelectorAll('[data-mode]').forEach(function(el){el.style.display=el.getAttribute('data-mode').split(' ').indexOf(r.value)>=0?'':'none'})}
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
var S=document.querySelector('meta[name=sc-sig]');
if(S){var cur=S.getAttribute('content');setInterval(function(){if(document.hidden)return;
fetch('/sig',{headers:{accept:'application/json'}}).then(function(r){return r.json()}).then(function(j){
if(j.sig&&j.sig!==cur){cur=j.sig;location.reload()}}).catch(function(){})},15000)}
})();
`;

type NavKey = 'checks' | 'channels' | 'folders' | 'billing' | 'guides';

export const Layout: FC<{
  title: string;
  account?: Account | null;
  nav?: NavKey;
  sig?: string;
  /** For public pages: shown in search results and link previews. */
  description?: string;
  /** Full-width page (the landing page lays out its own sections). */
  wide?: boolean;
  children?: Child;
}> = ({ title, account, nav, sig, description, wide, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {sig != null ? <meta name="sc-sig" content={sig} /> : null}
      <title>{title} · StepCanary</title>
      {description ? <meta name="description" content={description} /> : null}
      {description ? <meta property="og:title" content={`${title} · StepCanary`} /> : null}
      {description ? <meta property="og:description" content={description} /> : null}
      {description ? <meta property="og:type" content="website" /> : null}
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <div class="bar">
          <a class="brand" href="/">StepCanary</a>
          {account ? (
            <nav>
              <a href="/checks" class={nav === 'checks' ? 'on' : ''}>Checks</a>
              <a href="/channels" class={nav === 'channels' ? 'on' : ''}>Alert channels</a>
              {account.plan === 'agency' ? <a href="/folders" class={nav === 'folders' ? 'on' : ''}>Clients</a> : null}
              <a href="/billing" class={nav === 'billing' ? 'on' : ''}>Plan</a>
              <a href="/guides" class={nav === 'guides' ? 'on' : ''}>Guides</a>
            </nav>
          ) : (
            <nav>
              <a href="/#how">How it works</a>
              <a href="/#pricing">Pricing</a>
              <a href="/guides" class={nav === 'guides' ? 'on' : ''}>Guides</a>
            </nav>
          )}
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
      <main class={wide ? 'wide' : ''}>{children}</main>
      <script dangerouslySetInnerHTML={{ __html: JS }} />
    </body>
  </html>
);

const Time: FC<{ at: number | null; abs?: boolean }> = ({ at, abs }) =>
  at == null ? <span class="muted">never</span> : <time datetime={new Date(at).toISOString()} {...(abs ? { 'data-abs': '' } : {})}>{new Date(at).toISOString()}</time>;

/** A calendar date, shown in the viewer's own locale once the page script runs. */
const DateOnly: FC<{ at: number }> = ({ at }) => (
  <time datetime={new Date(at).toISOString()} data-date="">
    {new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}
  </time>
);

export const CHECK_DEFINITION =
  'A check is StepCanary’s watch on one automation. The automation pings the check each time it runs. If the pings stop, slow down, or start carrying blank data, the check alerts you.';

/** The word "check" with its definition one hover (or one click) away. */
export const CheckTerm: FC<{ children?: Child }> = ({ children }) => (
  <a class="term" href="/guides/checks" title={CHECK_DEFINITION}>
    {children ?? 'check'}
  </a>
);

const STATUS_HELP: Record<CheckStatus, string> = {
  new: 'New: waiting for the first ping. A check never alerts in this state.',
  up: 'Up: pings are arriving as expected.',
  late: 'Late: a ping is overdue but still inside the grace period. No alert yet.',
  down: 'Down: the grace period ran out, or the automation reported a failure. You have been alerted.',
  paused: 'Paused: switched off. It keeps its history and sends no alerts.',
};

const Status: FC<{ status: CheckStatus }> = ({ status }) => (
  <span class={`badge ${status}`} title={STATUS_HELP[status]}>
    {status}
  </span>
);

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
  if (check.cfg.mode === 'volume') return false;
  if (latestGapEnd == null || (check.state.status !== 'up' && check.state.status !== 'late')) return false;
  return latestGapEnd > Math.max(check.state.lastPingAt ?? 0, check.state.clockResetAt ?? 0);
}

const RUNAWAY_SHOW_MS = 10 * 60_000;
const isLooping = (c: Check, now: number) => c.runawayAt != null && now - c.runawayAt < RUNAWAY_SHOW_MS;

function pausedReason(reason: string | null): string | null {
  if (reason === 'plan_limit') return 'Paused because your plan’s check limit was reached. Upgrade or delete another check to resume it.';
  if (reason === 'plan_feature') return 'Paused because it uses a feature that is not in your current plan. Upgrade, or edit it to use interval mode, to resume it.';
  return null;
}

function warningLabel(w: string): string {
  if (w === 'malformed') return 'Malformed payload: the last ping’s JSON could not be read (the ping itself still counted).';
  if (w === 'too_large') return 'Payload too large to inspect (over 256 KB). The ping itself still counted.';
  return w;
}

/** Small notes shown next to a check's status. */
const Notes: FC<{ check: Check; latestGapEnd: number | null; now: number }> = ({ check: c, latestGapEnd, now }) => (
  <>
    {gapAffects(c, latestGapEnd) ? <span class="badge note" title="Timer restarted after a monitoring gap on our side">monitoring gap</span> : null}{' '}
    {isLooping(c, now) ? <span class="badge note" title="Pinging more than 60 times a minute">runaway loop</span> : null}{' '}
    {c.pendingShape ? <span class="badge note" title="The payload shape changed">payload changed</span> : null}{' '}
    {c.cfg.mode === 'volume' && c.baselineStatus === 'learning' && c.state.status !== 'new' ? <span class="badge note">learning</span> : null}{' '}
    {c.cfg.mode === 'volume' && c.baselineStatus === 'ready' ? <span class="badge note" title="Review the learned baseline to turn alerts on">baseline ready</span> : null}
  </>
);

// --- pages --------------------------------------------------------------------------------------

const LANDING_DESCRIPTION =
  'StepCanary watches your Zapier, Make, and n8n automations. Add one HTTP step; if an automation stops, slows down or starts sending blank data, you get a plain-English alert.';

const CATCHES: [string, string][] = [
  ['It stopped running', 'The Zap was switched off, a connection expired, or the trigger quietly stopped firing. You hear about it within minutes, not when a client asks where their leads went.'],
  ['It runs, but far less than usual', 'StepCanary learns what a normal Tuesday looks like. “Usually about 40 runs, only 3 yesterday” lands in your inbox at 8 AM.'],
  ['It runs, but the data is blank', 'A mapped field starts arriving empty after someone renames a form question. We notice the field went blank, without ever storing what was in it.'],
  ['It is stuck in a loop', 'A workflow that triggers itself can burn a month of tasks in an hour. We spot the flood and tell you once, not five hundred times.'],
];

const FAQ: [string, string][] = [
  ['What is a check?', 'A check is StepCanary’s watch on one automation. Your automation sends the check a tiny signal (a “ping”) every time it finishes. The check knows how often that should happen, and alerts you when the pings stop, slow down, or start carrying blank data. You create one check for each Zap, scenario, or workflow you want watched.'],
  ['Do you need access to my Zapier or Make account?', 'No. There is nothing to connect or authorize. You add one ordinary HTTP step to the automation, pointing at a private URL we give you. Remove the step and we are gone.'],
  ['What do you store?', 'Your email address, your check settings, and when each ping arrived. If you turn on payload monitoring we keep the names and types of the fields (“email: text”), never the values. Payments are handled by Stripe.'],
  ['Will it wake me up for nothing?', 'It is built not to. Business-hours automations can be given active hours so quiet nights and weekends never alert. Volume checks are compared by day of the week. And if we have a problem on our side, we show a “monitoring gap” instead of telling you your automation is down.'],
  ['Does it work on Zapier’s free plan?', 'The step uses “Webhooks by Zapier,” which Zapier includes on its paid plans. Make and n8n include HTTP steps on every plan.'],
  ['What happens if I move to a smaller plan?', 'Nothing is deleted. Checks over the smaller plan’s limit are paused, starting with the ones that pinged least recently, and resume if you upgrade again.'],
  ['Can I cancel?', 'Any time, from the Plan page. You keep what you paid for until the end of the billing period.'],
];

export const LandingPage: FC = () => (
  <Layout title="Know when your automations stop" description={LANDING_DESCRIPTION} wide>
    <section class="hero">
      <div class="inner">
        <p class="eyebrow">For Zapier, Make, and n8n</p>
        <h1>Know the moment an automation stops, before your client does.</h1>
        <p class="lede">
          Add one HTTP step to a Zap, scenario or workflow. If it stops running, runs far less than usual, or starts sending blank data,
          StepCanary tells you in plain English.
        </p>
        <p>
          <a class="btn primary big" href="/login">Start free</a> <a class="btn big" href="#how">See how it works</a>
        </p>
        <p class="muted small">Free for 3 automations. No card needed. Set up in about three minutes.</p>
      </div>
    </section>

    <section class="band">
      <div class="inner">
        <h2>Automations fail quietly. These are the four ways we catch.</h2>
        <div class="grid two">
          {CATCHES.map(([title, text]) => (
            <div class="card">
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>

    <section id="how">
      <div class="inner">
        <h2>How it works</h2>
        <p class="lede" style="text-align:center">
          You create a <CheckTerm /> for each automation you care about. A check is our watch on that one automation: it listens for a
          tiny signal every time the automation runs, and speaks up when the signals stop.
        </p>
        <div class="grid three">
          <div class="step">
            <span class="num">1</span>
            <strong>Create a check</strong>
            <p>One check per automation. Name it after the automation and say how often it should run, or let us learn that for you.</p>
          </div>
          <div class="step">
            <span class="num">2</span>
            <strong>Paste one URL</strong>
            <p>Add an HTTP step as the last step of your automation and paste in the URL we give you. Press “Test” and watch it connect.</p>
          </div>
          <div class="step">
            <span class="num">3</span>
            <strong>Get on with your day</strong>
            <p>Every run checks in. If the check-ins stop or change, you get an email, Slack or Discord message.</p>
          </div>
        </div>
        <div class="mock">
          <div class="mock-head">
            <strong>Down: “New lead → CRM” has stopped checking in</strong>
            <span class="muted small">StepCanary &lt;alerts@stepcanary.com&gt;</span>
          </div>
          <p>Your automation “New lead → CRM” has stopped checking in.</p>
          <p>
            What we expected: at least one ping every 2 hours, counted only during Mon–Fri, 9:00 AM–6:00 PM (America/New_York), with 15 minutes
            of grace.
            <br />
            What happened: nothing has arrived in time. The last successful ping arrived Tue, Nov 10, 2026, 10:42 AM EST (2 hours 15 minutes
            earlier).
          </p>
          <p class="muted">
            Common causes: the workflow was turned off or paused, an earlier step is failing, a connected account needs reconnecting, or the
            trigger has stopped firing.
          </p>
        </div>
        <p class="muted small" style="text-align:center">A real alert. It says which automation, what we expected, and what happened.</p>
        <p style="text-align:center">
          Step-by-step guides: <a href="/guides/zapier">Zapier</a> · <a href="/guides/make">Make</a> · <a href="/guides/n8n">n8n</a>
        </p>
      </div>
    </section>

    <section class="band">
      <div class="inner">
        <h2>Built to be trusted, not to be noisy</h2>
        <div class="grid three">
          <div class="card">
            <strong>Quiet when it should be</strong>
            <p>Lead forms sleep at night. Give a check active hours and the timer simply pauses outside them.</p>
          </div>
          <div class="card">
            <strong>Honest about our own bad days</strong>
            <p>
              We monitor ourselves every minute. If our side has a problem, you see “monitoring gap,” not a false “your automation is down.”
            </p>
          </div>
          <div class="card">
            <strong>We never keep your data</strong>
            <p>Payload monitoring looks at field names and whether each one is filled in. The contents are never stored.</p>
          </div>
        </div>
      </div>
    </section>

    <section id="pricing">
      <div class="inner">
        <h2>Pricing</h2>
        <div class="plans">
          {(['free', 'pro', 'agency'] as const).map((p) => (
            <div class="card" style={p === 'pro' ? 'border-color:var(--accent)' : ''}>
              <strong>{PLANS[p].label}</strong>
              <div class="price">{PLANS[p].priceLabel}</div>
              <ul>
                {PLAN_FEATURES[p].map((f) => (
                  <li>{f}</li>
                ))}
              </ul>
              <a class={p === 'pro' ? 'btn primary' : 'btn'} href="/login">{p === 'free' ? 'Start free' : `Start with ${PLANS[p].label}`}</a>
            </div>
          ))}
        </div>
        <p class="muted small" style="text-align:center;margin-top:14px">
          Everyone starts on Free. Upgrade from the Plan page when you need more; cancel any time.
        </p>
        <p class="muted small" style="text-align:center">
          Agencies: put each client’s automations in a folder and get a weekly health summary per client, ready to forward as proof of
          maintenance.
        </p>
      </div>
    </section>

    <section class="band">
      <div class="inner narrow">
        <h2>Questions</h2>
        {FAQ.map(([q, a]) => (
          <details class="faq">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>

    <section class="hero">
      <div class="inner">
        <h2 style="font-size:24px">Find out first.</h2>
        <p>
          <a class="btn primary big" href="/login">Start free</a>
        </p>
      </div>
    </section>

    <footer>
      <div class="inner">
        <span>© {new Date().getFullYear()} StepCanary</span> · <a href="/guides">Guides</a> · <a href="/login">Sign in</a>
      </div>
    </footer>
  </Layout>
);

export const GuidesIndexPage: FC<{ account?: Account | null; guides: { slug: string; platform: string; summary: string; closing?: string }[]; checkId?: string }> = ({
  account,
  guides,
  checkId,
}) => (
  <Layout title="Setup guides" account={account} nav="guides" description="Step-by-step guides for monitoring Zapier, Make, and n8n automations with StepCanary.">
    <h1>Setup guides</h1>
    <a class="card tile" href="/guides/checks">
      <strong>Start here: What is a check?</strong>
      <p>What a check does, why you need one, and a quick reference for every term and status.</p>
    </a>
    <p class="muted">Then pick the tool your automation runs in. Each guide takes about three minutes.</p>
    <div class="grid">
      {guides
        .filter((g) => !g.closing)
        .map((g) => (
          <a class="card tile" href={`/guides/${g.slug}${checkId ? `?check=${checkId}` : ''}`}>
            <strong>{g.platform}</strong>
            <p>{g.summary}</p>
          </a>
        ))}
    </div>
    {guides
      .filter((g) => g.closing)
      .map((g) => (
        <p class="muted small" style="margin-top:18px">
          Already on {g.platform}? {g.closing}{' '}
          <a href={`/guides/${g.slug}${checkId ? `?check=${checkId}` : ''}`}>{g.platform} guide for existing users</a>
        </p>
      ))}
  </Layout>
);

export const GuidePage: FC<{ account?: Account | null; title: string; html: string; personalized: boolean; concept?: boolean }> = ({
  account,
  title,
  html,
  personalized,
  concept,
}) => (
  <Layout title={title} account={account} nav="guides" description={`${title}: a step-by-step guide.`}>
    <p class="small">
      <a href="/guides">← All guides</a>
    </p>
    {personalized ? <div class="banner ok">The ping URL in this guide is the real one for your check, ready to copy.</div> : null}
    {!account && !concept ? (
      <div class="banner">
        You need a StepCanary check to follow this guide. <a href="/login">Create one free</a>. It takes a minute.
      </div>
    ) : null}
    <article class="card guide" dangerouslySetInnerHTML={{ __html: html }} />
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

const CheckTable: FC<{ checks: Check[]; sparks: Map<string, number[]>; latestGapEnd: number | null; now: number }> = ({
  checks,
  sparks,
  latestGapEnd,
  now,
}) => (
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
            <Status status={c.state.status} /> <Notes check={c} latestGapEnd={latestGapEnd} now={now} />
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
);

export const ChecksPage: FC<{
  account: Account;
  checks: Check[];
  sparks: Map<string, number[]>;
  gaps: GapRow[];
  latestGapEnd: number | null;
  limits: PlanLimits;
  folders: Folder[];
  sig: string;
  now: number;
}> = ({ account, checks, sparks, gaps, latestGapEnd, limits, folders, sig, now }) => {
  const active = checks.filter((c) => c.state.status !== 'paused').length;
  const groups: { title: string | null; checks: Check[] }[] = [];
  if (limits.folders && folders.length) {
    for (const f of folders) groups.push({ title: f.name, checks: checks.filter((c) => c.folderId === f.id) });
    const known = new Set(folders.map((f) => f.id));
    groups.push({ title: 'No client folder', checks: checks.filter((c) => !c.folderId || !known.has(c.folderId)) });
  } else {
    groups.push({ title: null, checks });
  }
  return (
    <Layout title="Checks" account={account} nav="checks" sig={sig}>
      <div class="row" style="margin-bottom:16px">
        <h1 style="margin:0">Checks</h1>
        <span class="muted small">
          {active} of {limits.maxChecks} active on the {limits.label} plan
        </span>
        <span class="spacer" style="flex:1" />
        <a class="btn primary" href="/checks/new">New check</a>
      </div>
      <p class="muted" style="margin:-6px 0 16px">
        Each <CheckTerm /> watches one automation and alerts you when it stops, slows down, or starts sending blank data.{' '}
        <a href="/guides/checks">What is a check?</a>
      </p>
      <GapBanner gaps={gaps} />
      {checks.length === 0 ? (
        <div class="card">
          <h2 style="margin-top:0">Start by creating your first check</h2>
          <p>
            A <strong>check</strong> is StepCanary’s watch on one of your automations. Automation tools tell you when a step fails with an
            error. They don’t tell you when an automation goes quiet: switched off, disconnected, or running with blank data. A check does.
          </p>
          <div class="explain">
            <div>
              <strong>1. It gives you a private URL</strong>
              <p>You paste it into one HTTP step at the end of your Zap, scenario, or workflow.</p>
            </div>
            <div>
              <strong>2. Your automation pings it</strong>
              <p>Every run sends a tiny “I just ran” signal. We never sign in to your tools or store your data.</p>
            </div>
            <div>
              <strong>3. It alerts you when that stops</strong>
              <p>If the pings stop, slow down, or change, you get a plain-English email, Slack, or Discord message.</p>
            </div>
          </div>
          <p>
            <a class="btn primary" href="/checks/new">Create your first check</a> <a class="btn" href="/guides/checks">Learn more about checks</a>
          </p>
          <p class="hint">One check per automation. It takes about two minutes.</p>
        </div>
      ) : (
        groups
          .filter((g) => g.checks.length > 0)
          .map((g) => (
            <>
              {g.title ? <h3>{g.title}</h3> : null}
              <div class="card" style="padding:4px 12px">
                <CheckTable checks={g.checks} sparks={sparks} latestGapEnd={latestGapEnd} now={now} />
              </div>
            </>
          ))
      )}
    </Layout>
  );
};

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
  check?: { id: string; name: string; cfg: CheckConfig; driftEnabled?: boolean; folderId?: string | null };
  channels: Channel[];
  selectedChannels?: string[];
  folders: Folder[];
  errors?: string[];
}> = ({ account, limits, check, channels, selectedChannels, folders, errors }) => {
  const cfg = check?.cfg;
  const [iv, iu] = splitDuration(cfg?.intervalSeconds ?? null, [1, 'hours']);
  const [gv, gu] = splitDuration(cfg?.graceSeconds ?? null, [10, 'minutes']);
  const mode = cfg?.mode ?? 'interval';
  const w = cfg?.activeWindow ?? null;
  const pro = (ok: boolean) => (ok ? '' : ' (Pro)');
  return (
    <Layout title={check ? `Edit ${check.name}` : 'New check'} account={account} nav="checks">
      <h1>{check ? 'Edit check' : 'New check'}</h1>
      {check ? null : (
        <div class="banner ok">
          <strong>A check watches one automation.</strong> Tell us how often the automation should run. We’ll give you a private URL to
          add as its last step, and alert you if it stops checking in. <a href="/guides/checks">What is a check?</a>
        </div>
      )}
      <form class="card" method="post" action={check ? `/checks/${check.id}` : '/checks'}>
        <Errors errors={errors} />
        <label for="name">Which automation is this?</label>
        <input id="name" name="name" type="text" maxlength={100} required value={check?.name ?? ''} placeholder="e.g. New lead → CRM" />

        {limits.folders ? (
          <>
            <label for="folder_id">Client folder</label>
            <select id="folder_id" name="folder_id">
              <option value="">No client folder</option>
              {folders.map((f) => (
                <option value={f.id} selected={check?.folderId === f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <label>How should we know it is healthy?</label>
        <label class="plain">
          <input type="radio" name="mode" value="interval" checked={mode === 'interval'} /> It should ping at least every…
        </label>
        <label class="plain">
          <input type="radio" name="mode" value="schedule" checked={mode === 'schedule'} disabled={!limits.scheduleMode} /> It should ping at
          set times (schedule){pro(limits.scheduleMode)}
        </label>
        <label class="plain">
          <input type="radio" name="mode" value="volume" checked={mode === 'volume'} disabled={!limits.volumeBaseline} /> It runs a lot: learn
          what is normal and tell me when volume drops{pro(limits.volumeBaseline)}
        </label>

        <div data-mode="interval">
          <label>Expect at least one ping every</label>
          <div class="row">
            <input type="number" name="interval_value" min="1" step="1" value={String(iv)} />
            <UnitSelect name="interval_unit" value={iu} />
          </div>
        </div>

        <div data-mode="schedule">
          <label for="cron">Schedule (cron format)</label>
          <input id="cron" name="cron" type="text" value={cfg?.cron ?? ''} placeholder="0 9 * * 1-5" />
          <div class="hint">
            Five fields: minute, hour, day of month, month, day of week. <code>0 9 * * 1-5</code> means 9:00 AM on weekdays.
          </div>
        </div>

        <div data-mode="volume">
          <label for="volume_pct">Alert when volume falls below</label>
          <div class="row">
            <input id="volume_pct" type="number" name="volume_pct" min="1" max="99" step="1" value={String(cfg?.volumeThresholdPct ?? 50)} /> % of
            normal
          </div>
          <div class="hint">
            We watch for {LEARNING_DAYS} days to learn what is normal for each day of the week, show you what we learned, and only start
            alerting once you switch it on.
          </div>
        </div>

        <div data-mode="interval volume">
          <label class="plain" style="margin-top:14px">
            <input type="checkbox" name="window_enabled" value="1" checked={!!w} disabled={!limits.activeWindows} /> Only count time during
            certain hours (active window){pro(limits.activeWindows)}
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

        <div data-mode="interval schedule">
          <label>Grace period</label>
          <div class="row">
            <input type="number" name="grace_value" min="1" step="1" value={String(gv)} />
            <UnitSelect name="grace_unit" value={gu} />
          </div>
          <div class="hint">How long we wait after a ping is due before alerting you.</div>
        </div>

        <label for="timezone">Timezone</label>
        <input id="timezone" name="timezone" type="text" value={cfg?.timezone ?? ''} placeholder="Europe/London" />

        <label>Payload</label>
        <label class="plain">
          <input type="checkbox" name="drift_enabled" value="1" checked={!!check?.driftEnabled} disabled={!limits.payloadDrift} /> Alert me when
          the data it sends changes shape (a field goes missing, goes blank, or changes type){pro(limits.payloadDrift)}
        </label>
        <div class="hint">We only ever look at field names and types, never the values.</div>

        <label>Send alerts to</label>
        <input type="hidden" name="channels_shown" value="1" />
        {channels.map((ch) => (
          <label class="plain">
            <input type="checkbox" name="channel_ids" value={ch.id} checked={selectedChannels ? selectedChannels.includes(ch.id) : true} />{' '}
            {KIND_LABEL[ch.kind]}: {ch.name} <span class="muted small">({ch.target})</span>
          </label>
        ))}
        <div class="hint">
          <a href="/channels">Add Slack, Discord or a webhook</a>
        </div>

        <p style="margin-top:20px">
          <button class="btn primary" type="submit">{check ? 'Save changes' : 'Create check'}</button>{' '}
          <a class="btn" href={check ? `/checks/${check.id}` : '/checks'}>Cancel</a>
        </p>
      </form>
    </Layout>
  );
};

const Shot: FC<{ label: string }> = ({ label }) => <div class="shot">[ Screenshot placeholder: {label} ]</div>;

const GuideLink: FC<{ slug: string; name: string; checkId: string }> = ({ slug, name, checkId }) => (
  <p class="hint">
    <a href={`/guides/${slug}?check=${checkId}`}>Full step-by-step guide for {name}, with your ping URL filled in →</a>
  </p>
);

const PlatformSettings: FC<{ url: string; checkId: string }> = ({ url, checkId }) => {
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
          <dt>Payload Type</dt><dd>JSON</dd>
          <dt>Data</dt><dd>Optional. Add fields you want watched, e.g. <code>email</code> → the mapped email.</dd>
          <dt>Everything else</dt><dd>Leave as it is, then click <strong>Test step</strong>.</dd>
        </dl>
        <GuideLink slug="zapier" name="Zapier" checkId={checkId} />
      </details>
      <details>
        <summary>Make</summary>
        <dl>
          <dt>Add module</dt><dd>HTTP → Make a request (last module of the scenario)</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Method</dt><dd>POST</dd>
          <dt>Authentication type</dt><dd>No authentication</dd>
          <dt>Body content type</dt><dd>application/JSON</dd>
          <dt>Body input method</dt><dd>JSON string</dd>
          <dt>Body content</dt><dd><code>{body}</code></dd>
          <dt>Older HTTP module?</dt><dd>On Version 3 the same settings are Body type: Raw, Content type: JSON (application/json), Request content.</dd>
          <dt>Then</dt><dd>Click <strong>Run once</strong>.</dd>
        </dl>
        <GuideLink slug="make" name="Make" checkId={checkId} />
      </details>
      <details>
        <summary>n8n</summary>
        <dl>
          <dt>Add node</dt><dd>HTTP Request (last node of the workflow)</dd>
          <dt>Method</dt><dd>POST</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Send Body</dt><dd>On · Body Content Type: JSON · Specify Body: Using JSON</dd>
          <dt>JSON</dt><dd><code>{body}</code></dd>
          <dt>Settings tab</dt><dd>On Error: Continue, so monitoring can never stop your workflow.</dd>
          <dt>Then</dt><dd>Click <strong>Execute step</strong>.</dd>
          <dt>Or import it</dt>
          <dd>
            <a href={`/templates/n8n/stepcanary-heartbeat.json?check=${checkId}`}>Download an n8n template</a> with this URL already filled in,
            then use Import from File in n8n.
          </dd>
        </dl>
        <GuideLink slug="n8n" name="n8n" checkId={checkId} />
      </details>
      <details>
        <summary>Pipedream (existing users)</summary>
        <dl>
          <dt>Note</dt><dd>Pipedream Workflows shuts down on March 31, 2027, and no longer accepts new signups.</dd>
          <dt>Add step</dt><dd>A Node.js code step as the last step (recommended), using the code in the guide below.</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Then</dt><dd>Click <strong>Test</strong>, then <strong>Deploy</strong>.</dd>
        </dl>
        <GuideLink slug="pipedream" name="Pipedream" checkId={checkId} />
      </details>
      <p class="hint">
        Advanced: send to <code>{url}/fail</code> from an error path to report a failure immediately, or <code>{url}/start</code> when a run
        begins.
      </p>
    </div>
  );
};

const VolumePanel: FC<{ check: Check; now: number }> = ({ check, now }) => {
  const b = check.baseline;
  const pct = check.cfg.volumeThresholdPct ?? 50;
  const table = b ? (
    <table>
      <thead>
        <tr>
          <th>Day</th>
          <th>Typical pings</th>
          <th>We would alert below</th>
        </tr>
      </thead>
      <tbody>
        {baselineRows(b).map(([day, n]) => (
          <tr>
            <td>{day}</td>
            <td>{n == null ? <span class="muted">no data</span> : n < 1 ? <span class="muted">normally quiet</span> : `about ${n}`}</td>
            <td>{n == null || n < 1 ? <span class="muted">never alerts</span> : Math.max(1, Math.ceil((n * pct) / 100))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : null;
  const relearn = (
    <form class="inline" method="post" action={`/checks/${check.id}/baseline/relearn`}>
      <button class="btn" type="submit">Relearn from the last {LEARNING_DAYS} days</button>
    </form>
  );

  if (check.baselineStatus === 'learning') {
    if (check.firstPingAt == null) {
      return (
        <div class="card">
          <h2 style="margin-top:0">Volume baseline</h2>
          <p>Learning starts with the first ping and takes {LEARNING_DAYS} days. No alerts are sent while we learn.</p>
        </div>
      );
    }
    const period = learningPeriod(check.firstPingAt, check.cfg.timezone);
    const day = Math.min(LEARNING_DAYS, Math.max(0, Math.floor((now - period.start) / 86_400_000)));
    return (
      <div class="card">
        <h2 style="margin-top:0">Volume baseline</h2>
        <p>
          <strong>Learning what is normal:</strong> day {day} of {LEARNING_DAYS}. We expect to have a baseline for you to review around{' '}
          <Time at={learningReadyAt(check.firstPingAt, check.cfg.timezone)} abs />, and we will email you when it is. No alerts are sent
          while we learn.
        </p>
      </div>
    );
  }
  if (check.baselineStatus === 'ready' && b) {
    return (
      <div class="card">
        <h2 style="margin-top:0">Volume baseline: ready for you to review</h2>
        <p>
          Here is what we learned from {b.days} days of pings. If it looks right, switch alerts on. We will tell you when a day’s total falls
          below {pct}% of what is typical for that day{b.granularity === 'hourly' ? ' (this check is busy enough that we also compare hour by hour)' : ''}.
          {b.granularity === 'daily' ? ` Each day is checked at 8:00 AM the next morning (${check.cfg.timezone}).` : ''}
        </p>
        {table}
        <p style="margin-top:14px">
          <form class="inline" method="post" action={`/checks/${check.id}/baseline/enable`}>
            <button class="btn primary" type="submit">Looks right. Turn on volume alerts</button>
          </form>{' '}
          {relearn}
        </p>
      </div>
    );
  }
  if (check.baselineStatus === 'active' && b) {
    return (
      <div class="card">
        <h2 style="margin-top:0">Volume baseline</h2>
        <p>
          Volume alerts are <strong>on</strong>: we alert when {b.granularity === 'hourly' ? 'an hour' : 'a day'} falls below {pct}% of normal.
          {b.granularity === 'daily' ? ` Each day is checked at 8:00 AM the next morning (${check.cfg.timezone}).` : ''}
        </p>
        {table}
        <p style="margin-top:14px">{relearn}</p>
        <p class="hint">Relearning replaces the baseline; you review it again before alerts resume.</p>
      </div>
    );
  }
  return null;
};

const DriftPanel: FC<{ check: Check }> = ({ check }) => {
  if (!check.driftEnabled) return null;
  if (check.pendingShape && check.acceptedShape) {
    const lines = describeChanges(diffShape(check.acceptedShape, check.pendingShape, check.optionalPaths));
    return (
      <div class="card" id="drift" style="border-color:#f0d58c">
        <h2 style="margin-top:0">The payload has changed shape</h2>
        <ul>
          {lines.map((l) => (
            <li>{l}</li>
          ))}
        </ul>
        <p class="hint">Only field names and types are compared. We never store what the fields contain.</p>
        <p>
          <form class="inline" method="post" action={`/checks/${check.id}/drift/accept`}>
            <button class="btn primary" type="submit">Accept new shape</button>
          </form>{' '}
          <form class="inline" method="post" action={`/checks/${check.id}/drift/optional`}>
            <button class="btn" type="submit">Mark as optional</button>
          </form>
        </p>
        <p class="hint">
          <strong>Accept new shape</strong>: this is the new normal. <strong>Mark as optional</strong>: these fields come and go (or are
          sometimes blank), so stop alerting about them.
        </p>
      </div>
    );
  }
  const keys = check.acceptedShape ? shapeKeys(check.acceptedShape) : [];
  return (
    <div class="card" id="drift">
      <h2 style="margin-top:0">Payload shape</h2>
      {check.acceptedShape ? (
        <>
          <p>Watching {keys.length} field{keys.length === 1 ? '' : 's'}. We will alert if one goes missing, goes blank or changes type.</p>
          <div>
            {keys.map((k) => (
              <span class="key">
                {k}
                {check.optionalPaths.includes(k) ? ' (optional)' : ''}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p class="muted">The next ping that carries data will define what is normal.</p>
      )}
    </div>
  );
};

const INCIDENT_LABEL = (i: IncidentRow): string => {
  if (i.kind === 'drift') return 'Payload changed shape';
  if (i.kind === 'runaway') return 'Runaway loop';
  if (i.reason === 'reported_failure') return 'Failure reported';
  if (i.reason === 'low_volume') return 'Volume dropped';
  return 'Stopped checking in';
};

export const CheckPage: FC<{
  account: Account;
  check: Check;
  pingUrl: string;
  pings: PingRow[];
  incidents: IncidentRow[];
  gapAffected: boolean;
  created?: boolean;
  notice?: string;
  sig: string;
  now: number;
}> = ({ account, check, pingUrl, pings, incidents, gapAffected, created, notice, sig, now }) => {
  const s = check.state;
  const connected = s.lastPingAt != null || s.lastStartAt != null || s.lastFailAt != null;
  const keys = check.lastShape ? shapeKeys(check.lastShape) : [];
  const why = s.status === 'paused' ? pausedReason(check.pausedReason) : null;
  return (
    <Layout title={check.name} account={account} nav="checks" sig={sig}>
      <p class="small">
        <a href="/checks">← All checks</a>
      </p>
      <div class="row" style="margin-bottom:16px">
        <h1 style="margin:0">{check.name}</h1>
        <Status status={s.status} />
        <Notes check={check} latestGapEnd={gapAffected ? Number.MAX_SAFE_INTEGER : null} now={now} />
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

      {notice ? <div class="banner ok">{notice}</div> : null}
      {created ? <div class="banner">Check created. Now add the ping step to your automation. This page updates by itself when the first ping arrives.</div> : null}
      {why ? <div class="banner">{why}</div> : null}
      {isLooping(check, now) ? (
        <div class="banner">
          <strong>Runaway loop detected.</strong> This automation is pinging more than 60 times a minute. We still count it as alive but are
          ignoring the extra pings. Check it for a loop that never ends or a workflow that triggers itself.
        </div>
      ) : null}
      {check.payloadWarning ? <div class="banner">{warningLabel(check.payloadWarning)}</div> : null}
      {gapAffected ? (
        <div class="banner">
          We had a monitoring gap on our side since this check’s last ping, so its timer restarted when the gap ended. No action needed.
        </div>
      ) : null}

      <DriftPanel check={check} />

      <div class="card">
        <strong>Ping URL</strong>
        <div class="row" style="margin-top:6px">
          <span class="url">{pingUrl}</span>
          <button class="btn" type="button" data-copy={pingUrl}>Copy</button>
        </div>
        <p class="hint">
          This <CheckTerm /> is watching one automation. We expect {describeExpectation(check.cfg)}.
        </p>
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

      {check.cfg.mode === 'volume' ? <VolumePanel check={check} now={now} /> : null}

      <PlatformSettings url={pingUrl} checkId={check.id} />

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
                  <td>{p.flags & FLAG_THROTTLED ? 'rate limited (loop)' : p.kind === 'ok' ? 'success' : p.kind === 'fail' ? 'failure reported' : 'run started'}</td>
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
          <p class="muted">None.</p>
        ) : (
          <table>
            <tbody>
              {incidents.map((i) => (
                <tr>
                  <td>{INCIDENT_LABEL(i)}</td>
                  <td><Time at={i.openedAt} abs /></td>
                  <td>
                    {i.resolvedAt ? (
                      `${i.kind === 'down' ? 'recovered' : 'closed'} after ${formatDuration((i.resolvedAt - i.openedAt) / 1000)}`
                    ) : (
                      <span class={`badge ${i.kind === 'down' ? 'down' : 'note'}`}>{i.kind === 'down' ? 'ongoing' : 'needs review'}</span>
                    )}
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

export const ChannelsPage: FC<{ account: Account; limits: PlanLimits; channels: Channel[]; errors?: string[]; notice?: string }> = ({
  account,
  limits,
  channels,
  errors,
  notice,
}) => (
  <Layout title="Alert channels" account={account} nav="channels">
    <h1>Alert channels</h1>
    {notice ? <div class="banner ok">{notice}</div> : null}
    <div class="card" style="padding:4px 12px">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Sends to</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {channels.map((ch) => (
            <tr>
              <td>{KIND_LABEL[ch.kind]}</td>
              <td>{ch.name}</td>
              <td class="muted small">{ch.target}</td>
              <td style="text-align:right">
                <form class="inline" method="post" action={`/channels/${ch.id}/test`}>
                  <button class="btn" type="submit">Send test</button>
                </form>{' '}
                {ch.kind !== 'email' ? (
                  <form class="inline" method="post" action={`/channels/${ch.id}/delete`} data-confirm="Remove this channel? Checks will stop alerting to it.">
                    <button class="btn danger" type="submit">Remove</button>
                  </form>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Add a channel</h2>
      {limits.extraChannels ? (
        <form method="post" action="/channels">
          <Errors errors={errors} />
          <label for="kind">Type</label>
          <select id="kind" name="kind">
            <option value="slack">Slack (incoming webhook)</option>
            <option value="discord">Discord (webhook)</option>
            <option value="webhook">Webhook (any URL, JSON POST)</option>
          </select>
          <label for="chname">Name</label>
          <input id="chname" name="name" type="text" maxlength={60} placeholder="e.g. #ops-alerts" />
          <label for="churl">Webhook URL</label>
          <input id="churl" name="url" type="url" required placeholder="https://hooks.slack.com/services/…" />
          <div class="hint">
            Stored encrypted and never shown again. A new channel is added to all your existing checks; you can turn it off for individual checks.
          </div>
          <p>
            <button class="btn primary" type="submit">Add channel</button>
          </p>
        </form>
      ) : (
        <p>
          Slack, Discord and webhook alerts are part of the Pro plan. <a href="/billing">See plans</a>
        </p>
      )}
    </div>
  </Layout>
);

export const FoldersPage: FC<{ account: Account; folders: Folder[]; errors?: string[] }> = ({ account, folders, errors }) => (
  <Layout title="Clients" account={account} nav="folders">
    <h1>Client folders</h1>
    <p class="muted">
      Group checks by client. Every Monday we email you one health summary per folder (total runs, uptime and incidents) that you can
      forward to the client as proof of maintenance.
    </p>
    <div class="card" style="padding:4px 12px">
      {folders.length === 0 ? (
        <p class="muted">No client folders yet.</p>
      ) : (
        <table>
          <tbody>
            {folders.map((f) => (
              <tr>
                <td>
                  <form class="row" method="post" action={`/folders/${f.id}`}>
                    <input type="text" name="name" value={f.name} maxlength={80} style="max-width:320px" />
                    <button class="btn" type="submit">Rename</button>
                  </form>
                </td>
                <td class="muted small">
                  {f.checks} check{f.checks === 1 ? '' : 's'}
                </td>
                <td style="text-align:right">
                  <form class="inline" method="post" action={`/folders/${f.id}/delete`} data-confirm="Delete this folder? Its checks are kept.">
                    <button class="btn danger" type="submit">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    <form class="card" method="post" action="/folders">
      <Errors errors={errors} />
      <label for="fname">New client folder</label>
      <div class="row">
        <input id="fname" type="text" name="name" maxlength={80} required placeholder="e.g. Acme Dental" style="max-width:320px" />
        <button class="btn primary" type="submit">Add folder</button>
      </div>
      <div class="hint">Put a check in a folder from the check’s Edit page.</div>
    </form>
  </Layout>
);

const PLAN_FEATURES: Record<string, string[]> = {
  free: ['3 checks', 'Email alerts', 'Interval mode'],
  pro: ['30 checks', 'Slack, Discord and webhook alerts', 'Schedules and active windows', 'Volume baseline', 'Payload drift alerts'],
  agency: ['150 checks', 'Everything in Pro', 'Client folders', 'Weekly client health summary emails'],
};

export const BillingPage: FC<{ account: Account; limits: PlanLimits; activeChecks: number; configured: boolean; notice?: string; errors?: string[] }> = ({
  account,
  limits,
  activeChecks,
  configured,
  notice,
  errors,
}) => (
  <Layout title="Plan" account={account} nav="billing">
    <h1>Plan</h1>
    {notice ? <div class="banner ok">{notice}</div> : null}
    <Errors errors={errors} />
    <p>
      You are on the <strong>{limits.label}</strong> plan, using {activeChecks} of {limits.maxChecks} <CheckTerm>checks</CheckTerm>. One
      check watches one automation; paused checks don’t count.
    </p>
    {limits.plan !== 'free' && account.planCancelAt ? (
      <div class="banner">
        <strong>Your subscription is canceled.</strong> You keep everything in {limits.label} until <DateOnly at={account.planCancelAt} />,
        because that time is already paid for. After that your account moves to Free and checks over the Free limit are paused, not
        deleted. Changed your mind? Use <strong>Manage billing</strong> to keep your plan.
      </div>
    ) : null}
    {limits.plan !== 'free' && !account.planCancelAt && account.planChangeTo && account.planChangeAt ? (
      <div class="banner">
        <strong>A plan change is scheduled.</strong> You keep everything in {limits.label} until <DateOnly at={account.planChangeAt} />,
        because that time is already paid for. On that date your plan changes to {limitsFor(account.planChangeTo).label}.
      </div>
    ) : null}
    {!configured ? <div class="banner">Paid plans are not available yet.</div> : null}
    <div class="plans">
      {(['free', 'pro', 'agency'] as const).map((p) => (
        <div class="card" style={p === limits.plan ? 'border-color:var(--accent)' : ''}>
          <strong>{PLANS[p].label}</strong>
          <div class="price">{PLANS[p].priceLabel}</div>
          <ul>
            {PLAN_FEATURES[p].map((f) => (
              <li>{f}</li>
            ))}
          </ul>
          {p === limits.plan ? (
            <span class="badge up">Current plan</span>
          ) : p === 'free' || limits.plan !== 'free' ? null : (
            <form method="post" action="/billing/checkout">
              <input type="hidden" name="plan" value={p} />
              <button class="btn primary" type="submit" disabled={!configured}>Choose {PLANS[p].label}</button>
            </form>
          )}
        </div>
      ))}
    </div>
    {account.stripeCustomerId && limits.plan !== 'free' ? (
      <div class="card" style="margin-top:16px">
        <form method="post" action="/billing/portal">
          <button class="btn primary" type="submit">Manage billing</button>
        </form>
        <p class="hint">Change plan, update your card, download invoices or cancel. Opens Stripe’s secure billing page.</p>
      </div>
    ) : null}
    <p class="hint">
      If you move to a smaller plan, checks over its limit are paused, not deleted, starting with the ones that pinged least recently.
    </p>
  </Layout>
);

export const MessagePage: FC<{ account?: Account | null; title: string; message: string }> = ({ account, title, message }) => (
  <Layout title={title} account={account}>
    <div class="card">
      <h1>{title}</h1>
      <p>{message}</p>
      <a class="btn" href="/checks">Back to checks</a>
    </div>
  </Layout>
);
