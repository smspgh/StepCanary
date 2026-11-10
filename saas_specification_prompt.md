You are a senior engineer helping a solo developer build a tiny, extremely reliable SaaS with minimal maintenance. Optimize for: very few moving parts, no false alarms, no storage of customer data, and fully self-serve onboarding.

## PRODUCT
A "dead man's switch" SaaS solution we are calling StepCanary for no-code automations (Zapier, Make, n8n, Pipedream). Users add one HTTP request step to a workflow that pings our unique URL. If the pings stop, arrive far less often than usual, or the payload shape changes, we alert them. Competitors like Healthchecks.io and Cronitor target developers and cron jobs; we target no-code users with copy-paste templates and plain-English alerts.

## CORE FEATURES (MVP)
1. **Checks:** each check has a unique, unguessable ping URL.
   - Endpoints: `GET/POST /p/{token}` (success), `/p/{token}/fail` (explicit failure), `/p/{token}/start` (optional).
   - Ping endpoint must be fast and always return 200 quickly; do all evaluation asynchronously.
   - Statuses: `new` (waiting for first ping—never alert while in `new`), `up`, `late` (in grace period), `down`, `paused`.
   - Forgiving ingestion: accept JSON, `application/x-www-form-urlencoded`, or query parameters interchangeably. If a POST body contains malformed/unparseable JSON (common when no-code users map unescaped strings), still record the ping timestamp so uptime isn't falsely marked down, but flag a "Malformed Payload" warning on the check.
   - Runaway loop protection: rate-limit ingestion per token (e.g., >60 pings/min) at the edge/ingestion layer to protect our DB/bills from accidental no-code infinite loops, and trigger a "Runaway Loop Detected" alert.
2. **Expectation modes per check:**
   - **a) Interval:** "at least one ping every X minutes/hours" + grace period.
   - **b) Schedule:** cron-style expected times + grace period, with timezone.
   - **c) Volume baseline:** learn the typical count per hour/day over the first 14 days (bucketed by Day-of-Week and Hour-of-Day so weekend dips don't trigger false alerts), then alert when volume drops below a user-adjustable % of normal (e.g., "usually ~40/day, got 3 today"). Show the learned baseline to the user before enabling.
   - **d) Active Window modifier (applies to Interval and Volume modes):** optional day-of-week + time-of-day window (e.g., Mon–Fri, 9am–6pm in user's timezone) so business-hours automations (like lead forms) pause their timer and don't trigger false alarms on nights and weekends.
3. **Payload drift (optional per check):** if the POST body is JSON, form-data, or query params, compute a "shape fingerprint" (sorted key paths + value types only, never values). Alert when the shape changes (keys added/removed/type changed), showing a diff of key names only. Never store payload values or full bodies.
   - No-code empty-value detection: in Zapier/Make, broken mapped variables often resolve to `""` (empty string) rather than `null` or a missing key. The shape fingerprint must treat `empty_string` (including whitespace-only), `null`, and `empty_array` as distinct types from populated `string`/`array` so we catch fields silently going blank.
   - One-click "Accept new shape" or "Mark key as optional/nullable" button in the alert link and dashboard to prevent alert fatigue on optional form fields.
4. **Alerts:** email, Slack incoming webhook, Discord webhook, and generic webhook. Alerts on "down", "recovered", "payload drift", and "runaway loop". Plain-English message saying which automation, what was expected, what happened, and a link to the check.
5. **Dashboard:** list of checks with status (`new` / `up` / `late` / `down` / `paused`), last ping time, 7-day sparkline.

## RELIABILITY RULES (most important part)
- Evaluator job runs every minute.
- Self-protection against false alarms: if our own ingestion or evaluator was unhealthy during a window (e.g., ingest gap, job missed runs, database errors), suppress "down" alerts for that window and instead show "monitoring gap" on the dashboard.
- Idempotent alert sending (never double-alert for the same incident).
- External uptime monitoring of our own ping endpoint and a dead man's switch for our own evaluator job.
- Document a simple recovery runbook.

## ONBOARDING TEMPLATES
- Step-by-step guides with screenshot placeholders for: Zapier ("Webhooks by Zapier" POST step), Make (HTTP "Make a request" module), n8n (HTTP Request node), Pipedream.
- Each check's page shows the exact settings to copy for each platform.
- Include a "Listening for your first ping..." live indicator on the check creation screen that automatically flips to "Connected! First ping received" and displays the detected payload keys when the user clicks "Test Step" in Zapier/Make/n8n.

## PRICING (Stripe Checkout + Customer Portal)
- **Free:** 3 checks, email alerts, interval mode.
- **Pro ($15/mo):** 30 checks, all alert channels, active windows, volume baseline, payload drift.
- **Agency ($49/mo):** 150 checks, client folders, shared alert channels, plus an automated "Weekly Client Health Summary" email per client folder showing total pings and uptime status that agencies can forward to retainer clients as proof of maintenance.

## TECH CONSTRAINTS
- Suggest the simplest boring stack and justify it. Prefer managed services. The ping endpoint should be able to run on edge/serverless if that's simpler and more reliable.
- Data retention: keep ping timestamps and counts for 30 days (aggregate older data into daily counts), then delete.
- Magic-link login.
- Tests: unit tests for interval/schedule/baseline evaluation (including DST changes, timezones, and Active Windows), fingerprint generation (including empty string/null distinctions and malformed JSON fallback), per-token rate limiting, alert idempotency, and the "monitoring gap" suppression logic.

## DO NOT
- Do not use Zapier/Make/n8n APIs or OAuth — integration is only "user adds an HTTP step". This avoids platform dependency.
- Do not store payload contents.
- Do not add team permissions, SSO, or status pages in v1.

## HOW TO WORK
1. First reply with: architecture overview, stack + reasons, data model, how the evaluator and false-alarm suppression work, monthly cost at 0 / 100 / 1,000 users, and assumptions. **STOP for approval.**
2. Build the MVP (checks, ping endpoints, interval + schedule + active window modes, email alerts, dashboard, live first-ping listener) with tests and deployment steps. **STOP for review.**
3. Add volume baseline, payload drift (with empty-value detection), runaway loop protection, Slack/Discord/webhook alerts, Agency weekly summary email, and billing. **STOP for review.**
4. Write the 4 platform onboarding guides and a launch checklist, plus a list of ongoing maintenance tasks with estimated hours per month.