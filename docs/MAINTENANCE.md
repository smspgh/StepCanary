# Ongoing maintenance

StepCanary is designed to need very little attention: no servers, managed database, and it
tells you when it is unwell. The estimates below are for a small service (up to about 1,000
users). Support time is separate and depends on how many customers you have.

**Expected total: about 2 to 3 hours a month**, plus roughly 2 hours once a quarter.

## Every week (about 10 minutes)

| Task | How | Time |
|---|---|---|
| Glance at self-monitoring | Healthchecks.io and UptimeRobot are green; no alert emails you ignored. | 2 min |
| Look for stuck alerts | Run the "stuck or failed" SQL from `docs/RUNBOOK.md`. A few `failed` webhook deliveries are normal (customers delete webhooks). Many failures, or any failed **email**, need a look. | 3 min |
| Look for monitoring gaps | `SELECT * FROM monitoring_gaps ORDER BY ended_at DESC LIMIT 10;` Occasional short gaps are fine. A pattern (same time daily, growing length) is worth investigating. | 3 min |
| Stripe | Failed payments and disputes in the Stripe dashboard. | 2 min |

## Every month (about 1.5 hours)

| Task | How | Time |
|---|---|---|
| Update dependencies | `npm outdated`, `npm update`, then `npm test`, `npm run build:check`, deploy the app Worker, and watch Healthchecks for ten minutes. Deploy the ingest Worker only if `src/ingest` or `src/shared` changed. | 45 min |
| Review costs | Cloudflare (Workers requests, Queues operations), Neon (compute hours, storage), Resend (emails sent against your tier). Compare with last month. | 15 min |
| Review growth against limits | Row counts: `SELECT count(*) FROM pings;` and database size in Neon. Email volume against the Resend tier. | 10 min |
| Read evaluator health | `SELECT count(*) FILTER (WHERE NOT healthy) AS unhealthy, count(*) AS runs, sum(errors) AS errors FROM evaluator_runs;` (covers the last 7 days). `errors` should be 0. | 5 min |
| Skim the logs | `npx wrangler tail stepcanary-app` for a few minutes, or the Workers Logs view, searching for `_failed` and `app_error`. | 15 min |

## Every quarter (about 2 hours)

| Task | How | Time |
|---|---|---|
| Restore drill | In Neon, create a branch from a point in time a day ago. Connect to it and confirm recent rows are there (`SELECT max(received_at) FROM pings;`). Delete the branch. You are proving the restore path works before you need it. | 30 min |
| Check the guides against the platforms | Open Zapier, Make, n8n and Pipedream and compare the screens with `docs/guides/`. These tools rename fields often. Update the guides and the "Exact settings to copy" panel in `src/app/views.tsx`. | 45 min |
| End-to-end test in production | The smoke test in `docs/DEPLOY.md` step 7, plus one Slack test alert and one test-mode Stripe purchase. | 30 min |
| Review access | Who has access to Cloudflare, Neon, Stripe, Resend and GitHub; two-factor authentication is on for all of them. | 15 min |

## Every year (about 2 hours)

| Task | How | Time |
|---|---|---|
| Domain renewal | Confirm auto-renew is on for `stepcanary.com` and the card on file is valid. | 5 min |
| Runtime update | Raise `compatibility_date` in both `wrangler.*.jsonc` files to a recent date, run tests, deploy to both Workers, do the smoke test. | 45 min |
| Major dependency upgrades | Hono, Wrangler, postgres.js, Luxon, croner major versions: read the changelogs, upgrade one at a time, run tests. Pay special attention to croner (schedule and DST behavior is pinned by tests in `test/evaluate.test.ts`). | 60 min |
| Rotate API keys | New Resend API key and Stripe restricted key; update with `wrangler secret put`. **Never rotate `TOKEN_SECRET` or `CHANNEL_KEY`.** | 15 min |

## When something changes

| Event | What to do |
|---|---|
| Timezone database changes (a country changes its DST rules) | Nothing to deploy for evaluation: Workers pick up new timezone data with runtime updates. Raise `compatibility_date` if a customer reports a schedule that is an hour off. |
| A platform changes its HTTP step | Update the matching guide and the panel in `src/app/views.tsx`. Ping URLs keep working; only instructions change. |
| Approaching 100 emails a day or 3,000 a month | Upgrade Resend, or switch to Postmark by changing `EMAIL_PROVIDER` and adding `POSTMARK_TOKEN`. |
| Database nearing its storage or compute tier | Raise the Neon tier. If `pings` is the cause, raw-ping retention can be shortened in `src/app/retention.ts` without affecting alerts. |
| Price change | Create new prices in Stripe, update `STRIPE_PRICE_PRO` / `STRIPE_PRICE_AGENCY` and the labels in `src/core/plans.ts`. Existing subscribers stay on their old price until you migrate them in Stripe. |

## What does not need doing

- **Backups:** Neon keeps continuous history; there is nothing to schedule. The quarterly drill is the only backup task.
- **Data cleanup:** the retention job runs daily by itself.
- **Scaling:** Workers and the queue scale without intervention. The first limit you would meet is the evaluator's 5,000 checks per minute, which is far beyond the 1,000-user estimate.
- **Certificates:** Cloudflare renews them.
