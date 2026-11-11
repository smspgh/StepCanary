# StepCanary recovery runbook

The system is built to fail quiet: when we are broken, customers see a "monitoring gap" on the
dashboard instead of false "down" alerts, and pings wait in the queue (about a day) rather than
being lost. So in almost every incident the right first move is **look, don't rush**.

## First look (2 minutes)

```powershell
npx wrangler tail stepcanary-app --format pretty      # live logs: evaluator, consumer, dashboard
npx wrangler tail stepcanary-ingest --format pretty   # live logs: ping endpoint
npx wrangler queues info stepcanary-pings             # backlog size
```

Also check <https://www.cloudflarestatus.com> and <https://neonstatus.com>.

Log lines to search for: `evaluator_unhealthy`, `evaluator_failed`, `consume_failed`,
`queue_send_failed`, `alert_send_failed`, `evaluate_check_failed`, `app_error`.

Useful SQL (Neon SQL editor):

```sql
-- Is the evaluator running, and does it think it is healthy?
SELECT minute, started_at, finished_at, healthy, evaluated, transitions, errors, note
  FROM evaluator_runs ORDER BY minute DESC LIMIT 15;

-- When did the ingestion canary last arrive?
SELECT to_timestamp(value::bigint / 1000.0) AS canary_last_seen FROM system_state WHERE key = 'canary_last_ping_at';

-- Recent monitoring gaps
SELECT * FROM monitoring_gaps ORDER BY ended_at DESC LIMIT 10;

-- Alerts that are stuck or failed
SELECT status, attempts, last_error, subject, next_attempt_at FROM alert_deliveries
 WHERE status <> 'sent' ORDER BY created_at DESC LIMIT 20;
```

## Scenarios

### Healthchecks.io says the evaluator is late or failing

| What you see | Meaning | Do |
|---|---|---|
| No recent rows in `evaluator_runs` | Cron is not firing or the Worker crashes at start | Check Cloudflare status and `wrangler tail`. If it started after a deploy: `npx wrangler rollback -c wrangler.app.jsonc`. |
| Rows with `finished_at` NULL | The run crashes midway, usually a database error | Check Neon status and the Hyperdrive config. |
| `note` contains `ingest_stalled` | Canary pings are not reaching the database | See "Queue backlog" below. |
| `errors` > 0 but `healthy` true | One specific check fails to evaluate | Find `evaluate_check_failed <check id>` in the logs; pause that check with `UPDATE checks SET status = 'paused', next_eval_at = NULL WHERE id = '...'` and fix the cause. |

Nothing needs to be "repaired" afterward. The next healthy run records the gap, and evaluation
resumes on the run after that.

### Queue backlog / `consume_failed`

The consumer cannot write to the database. Pings are safe in the queue and are retried with
backoff for about a day. Fix the database (next section); the backlog then drains by itself,
late batches are recorded as a monitoring gap, and no false alarms are sent. If an outage will
exceed a day, pings will start to be dropped; that still cannot cause false alarms, because the
gap restarts every check's clock.

### Database down, or connection errors

1. Check Neon status and the project's console (compute suspended? storage or plan limit hit?).
2. If the password or host changed:
   `npx wrangler hyperdrive update <HYPERDRIVE_ID> --connection-string="postgres://..."`.
3. No redeploy is needed.

### Database damaged (bad migration, accidental delete)

1. In Neon, create a branch from a point in time just before the damage (point-in-time restore).
2. Point Hyperdrive at the branch's connection string (command above).
3. Pings received between that time and now are missing from the restored data. This is safe:
   the evaluator notices the discontinuity or you can force it:
   `INSERT INTO monitoring_gaps (id, started_at, ended_at, reason) VALUES (gen_random_uuid()::text, '<restore point>', now(), 'manual_restore');`
   which restarts every check's clock from now.

### Ping endpoint down (UptimeRobot alert)

1. Cloudflare status first; an edge outage is outside our control and self-heals.
2. If it started after an ingest deploy: `npx wrangler rollback -c wrangler.ingest.jsonc`.
3. Customers' automations are not harmed beyond a failed HTTP step, and when ingestion returns
   the canary gap prevents false alarms.

### Emails are not arriving

1. Run the "stuck or failed" SQL above and read `last_error`.
2. Check the provider dashboard (bounces, domain verification, quota).
3. To switch provider: set `EMAIL_PROVIDER` in `wrangler.app.jsonc`, add the other provider's
   secret, `npm run deploy:app`. To re-queue alerts that gave up:
   `UPDATE alert_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE status = 'failed' AND created_at > now() - interval '6 hours';`

### A bad deploy

`npx wrangler rollback -c wrangler.app.jsonc` (or `wrangler.ingest.jsonc`). Rollbacks are instant
and do not touch the database.

### We sent a false alarm anyway

1. Find the incident and compare `opened_at` with `evaluator_runs` and `monitoring_gaps` around it.
2. If our pipeline was unhealthy and no gap was recorded, that is a bug in `src/core/health.ts`.
   Add a failing test to `test/pipeline.test.ts` first, then fix.
3. To stop a wave in progress, pause evaluation without losing pings: remove the cron trigger in
   `wrangler.app.jsonc`, deploy, fix, restore, deploy. The pause is recorded as a gap automatically.

### A customer paid but is still on Free

1. Stripe → Developers → Webhooks → the endpoint → recent deliveries. A failing delivery shows the status we returned.
   400 means the signing secret is wrong (`STRIPE_WEBHOOK_SECRET`); 500 means we could not reach Stripe or the database.
2. Fix the cause, then press "Resend" on the event in Stripe. Handling an event twice is harmless.
3. To unblock the customer immediately: `UPDATE accounts SET plan = 'pro' WHERE email = '...';`
   The next subscription event from Stripe will overwrite this with the real state.

### Alerts to Slack / Discord / a webhook are failing

Run the "stuck or failed" SQL above. `last_error` shows the HTTP status the customer's webhook returned
(404 or 410 usually means they deleted the webhook). We retry 10 times over about a day, then give up on
that one alert. Email to the same check is unaffected. If every webhook delivery fails with a decryption
error, `CHANNEL_KEY` is missing or was changed.

### A customer says volume or drift alerts are wrong

- Drift: on the check page, "Accept new shape" or "Mark as optional" ends it. Turning drift off and on again
  relearns from the next payload.
- Volume: "Relearn from the last 14 days" on the check page replaces the baseline; they review it before it
  alerts again. The threshold percentage is on the Edit page.

## Things never to do

- **Never change `TOKEN_SECRET`.** Every existing ping URL would stop working.
- **Never change `CHANNEL_KEY`.** Every stored Slack/Discord/webhook URL would become unreadable.
- Never purge the `stepcanary-pings` queue unless you accept losing those pings.
- Never turn Hyperdrive caching on.
- Never delete rows from `incidents` or `alert_deliveries` to "resend" something; they are what
  prevents duplicate alerts. Use the re-queue statement above.
