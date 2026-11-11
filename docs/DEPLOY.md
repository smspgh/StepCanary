# Deploying StepCanary

Commands are PowerShell, run from the project folder. Replace `stepcanary.com` with your domain.
Plan for about an hour the first time.

## 0. Accounts you need

| Service | Why | Plan |
|---|---|---|
| Cloudflare | Workers, Queues, Hyperdrive, DNS | Workers Paid |
| Neon | Postgres | Launch (the every-minute evaluator keeps compute awake, so the free tier's hours run out) |
| Resend (or Postmark) | Email | Resend free tier is fine to start |
| Healthchecks.io | Dead man's switch for our own evaluator | Free |
| UptimeRobot (or similar) | External uptime check of the ping endpoint | Free |

Your domain's DNS must be on Cloudflare. Check current prices on each provider's pricing page
before committing; the figures in the design notes were estimates.

## 1. Database

1. Create a Neon project in a region close to most of your users.
2. Copy the **direct** connection string (host without `-pooler`). Hyperdrive does the pooling.
3. Apply the schema:

```powershell
$env:DATABASE_URL = "postgres://USER:PASSWORD@HOST/DB?sslmode=require"
npm run migrate
```

## 2. Cloudflare resources

```powershell
npx wrangler login
npx wrangler queues create stepcanary-pings
npx wrangler hyperdrive create stepcanary-db --connection-string="$env:DATABASE_URL" --caching-disabled
```

- **`--caching-disabled` is required.** Hyperdrive caches read queries by default; the evaluator
  and the first-ping listener must always see fresh rows.
- Paste the Hyperdrive id that the command prints into `wrangler.app.jsonc`
  (`"id": "REPLACE_WITH_HYPERDRIVE_ID"`).

## 3. Configuration

In `wrangler.app.jsonc`, set `vars`:

```jsonc
"APP_URL": "https://app.stepcanary.com",
"PING_URL": "https://ping.stepcanary.com",
"EMAIL_PROVIDER": "resend",                      // or "postmark"
"EMAIL_FROM": "StepCanary <alerts@stepcanary.com>",
"DEFAULT_PLAN": "free"
```

Uncomment the `routes` line in **both** `wrangler.app.jsonc` and `wrangler.ingest.jsonc` and set
your hostnames. Cloudflare creates the DNS records and certificates.

## 4. Secrets

```powershell
npm run gen:secret        # prints a random value; use the SAME value for both Workers
npx wrangler secret put TOKEN_SECRET -c wrangler.ingest.jsonc
npx wrangler secret put TOKEN_SECRET -c wrangler.app.jsonc
npx wrangler secret put RESEND_API_KEY -c wrangler.app.jsonc      # or POSTMARK_TOKEN
npx wrangler secret put EVALUATOR_HEARTBEAT_URL -c wrangler.app.jsonc   # from step 6
```

**Store `TOKEN_SECRET` in your password manager.** Every customer's ping URL is derived from it.
If it is lost or changed, every ping URL stops working.

## 5. Deploy

The ingest Worker goes first, because the app Worker binds to it.

```powershell
npm test
npm run deploy:ingest
npm run deploy:app
```

In Resend (or Postmark), verify your sending domain (SPF and DKIM records) before relying on
email. Until then, alerts and sign-in links may land in spam or be rejected.

## 6. Monitoring of ourselves

1. **Healthchecks.io** – create a check with period 1 minute and grace 5 minutes. Put its ping
   URL in `EVALUATOR_HEARTBEAT_URL` (step 4). The evaluator pings it after every clean run and
   pings `/fail` when it finds itself unhealthy (stalled ingestion, database errors). Send its
   alerts to your phone.
2. **UptimeRobot** – monitor `https://ping.stepcanary.com/healthz` every 5 minutes, and
   `https://app.stepcanary.com/healthz` too.

## 7. Smoke test (10 minutes)

1. Open `https://app.stepcanary.com`, sign in, and confirm the email arrives.
2. Create a check: every 1 minute, grace 1 minute.
3. Run `curl -X POST https://ping.stepcanary.com/p/<token> -H "content-type: application/json" -d '{\"hello\":\"world\"}'`.
   The check page should flip to "Connected" within a couple of seconds and list `hello`.
4. Wait about 5 minutes without pinging. You should get one "Down" email, and only one.
5. Ping again. You should get one "Recovered" email.
6. Confirm the Healthchecks.io check is green, then delete the test check.

Note: for the first two minutes after any first deploy the evaluator deliberately evaluates
nothing (it needs two consecutive healthy runs).

## Later deploys

```powershell
npm test
npm run deploy:app        # most changes
npm run deploy:ingest     # only when src/ingest or src/shared changed
```

New migration files: run `npm run migrate` **before** deploying code that needs them. Roll back a
bad deploy with `npx wrangler rollback -c wrangler.app.jsonc` (or `wrangler.ingest.jsonc`).

## Verification status

Verified in production on 10 Nov 2026 (app.stepcanary.com / ping.stepcanary.com): deploy of both
Workers, Hyperdrive to Neon, custom domains, magic-link sign-in, first-ping listener, one "Down"
email, one "Recovered" email via Resend, and the Healthchecks.io heartbeat.

## Gotchas met during the first deploy

- **New Cloudflare account:** open Workers & Pages in the dashboard once before deploying. Until the
  account has a workers.dev subdomain, cron schedules and queue consumers fail to attach (error 10063).
- **`wrangler secret put NAME`:** the argument is the secret's name. Paste the value only at the
  prompt. Secret names are visible, so a value typed as the name must be treated as leaked.
- **New cron schedules** can take several minutes to start firing after the first deploy.
