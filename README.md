# StepCanary

A dead man's switch for no-code automations (Zapier, Make, n8n, Pipedream). Users add one HTTP
step that pings a unique URL; if the pings stop, StepCanary alerts them in plain English.

Status: **Step 2 (MVP)** – checks, ping endpoints, interval + schedule + active-window modes,
email alerts, dashboard, live first-ping listener, self-monitoring with false-alarm suppression.
Volume baselines, payload-drift alerts, runaway-loop protection, Slack/Discord/webhook channels
and billing arrive in Step 3.

## How it fits together

```
automation ──HTTP──▶ ingest Worker ──▶ Queue ──▶ app Worker (consumer) ──▶ Postgres
                     src/ingest                  app Worker (cron, every minute): evaluator + alert sender
                                                 app Worker (HTTP): dashboard, magic-link login
```

| Path | What it is |
|---|---|
| `src/ingest/` | Ping endpoint. Validates the token without a database, fingerprints the payload shape, drops the body, queues the ping, answers 200. |
| `src/core/` | Pure logic with no I/O: deadlines, active windows, schedules, self-health, alert wording, form validation. |
| `src/app/` | Queue consumer, evaluator, alert outbox, retention, auth, dashboard. |
| `src/shared/` | Token, shape fingerprint and queue message format used by both Workers. |
| `migrations/` | Postgres schema. |
| `test/` | Unit tests plus database-backed tests that run the real SQL on PGlite (in-process Postgres). |
| `docs/DEPLOY.md` | First deployment, step by step. |
| `docs/RUNBOOK.md` | What to do when something breaks. |

## Reliability rules, and where they live

- **Never alert before the first ping** – `evaluate()` ignores `new` checks (`src/core/evaluate.ts`).
- **No false alarms when we are the broken one** – `src/core/health.ts` checks evaluator continuity
  and an ingestion canary every minute. If either fails, a monitoring gap is recorded, "down"
  alerts are held back, and every check's clock restarts when the gap ends.
- **Never double-alert** – one open incident per check and one delivery per
  (incident, event, channel), both enforced by unique indexes (`migrations/0001_init.sql`,
  `src/app/alerts.ts`).
- **Never store payload contents** – only key names and value types leave the ingest Worker
  (`src/shared/fingerprint.ts`); dynamic keys such as emails and UUIDs become placeholders.
- **Never break the customer's workflow** – a genuine ping URL always gets a 200, even if our
  queue is down.

## Local development

No Postgres or Docker needed.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run dev:db      # terminal 1: local database on 127.0.0.1:5433 (data in .dev-db/)
npm run dev         # terminal 2: both Workers on http://localhost:8787
```

- Sign in at <http://localhost:8787/login>. With `EMAIL_PROVIDER=console` the sign-in link is
  printed in the `npm run dev` terminal instead of being emailed.
- Ping URLs look like `http://localhost:8787/p/<token>`.
- Cron does not fire by itself locally. Trigger one evaluator minute with
  `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`. The evaluator needs runs about a
  minute apart (it treats longer pauses as a monitoring gap, by design), so to watch a check go
  down, call it once a minute.

## Tests

```powershell
npm test            # 115 tests, about 3 seconds
npm run typecheck
npm run build:check # bundles both Workers without deploying
```
