# Launch checklist

Work top to bottom. Items marked **(blocker)** should be done before the first paying customer;
the rest can follow in the first weeks.

## 1. Production is complete

- [ ] **(blocker)** Step 3 is deployed (`docs/STEP3.md`, Part A): migrations applied, `CHANNEL_KEY` set, both Workers deployed.
- [ ] **(blocker)** Stripe is live (`docs/STEP3.md`, Part B): live prices, live webhook, live keys, customer portal configured.
- [ ] **(blocker)** A real purchase works end to end in live mode with your own card, including switching plan and cancelling. Refund yourself afterwards.
- [ ] **(blocker)** `TOKEN_SECRET` and `CHANNEL_KEY` are in your password manager. Neither can ever be changed or recovered.
- [ ] Healthchecks.io check is green and alerts go to your phone, not only email.
- [ ] UptimeRobot monitors `ping.stepcanary.com/healthz` and `app.stepcanary.com/healthz` and both are green.
- [ ] `DEFAULT_PLAN` in `wrangler.app.jsonc` is `free`.

## 2. It works on the real platforms

The guides were written from documentation knowledge, not by clicking through each tool. Do
this once per platform with a real account, and fix any wording that does not match the screen.

- [ ] **(blocker)** Zapier: follow `docs/guides/zapier.md` exactly. The check flips to "Connected" on Test step.
- [ ] **(blocker)** Make: follow `docs/guides/make.md`.
- [ ] n8n: follow `docs/guides/n8n.md`.
- [ ] Pipedream: follow `docs/guides/pipedream.md`.
- [ ] Take the screenshots named in each guide's placeholders and add them.
- [ ] On one platform, map a field, enable drift, then blank the field: the drift alert arrives and "Mark as optional" silences it.
- [ ] Publish the guides where customers can reach them (help site or pages in the app) and link them from the check page.

## 3. Alerts arrive

- [ ] **(blocker)** Resend shows `stepcanary.com` as verified (SPF and DKIM).
- [ ] **(blocker)** Add a DMARC record for `stepcanary.com` (start with `v=DMARC1; p=none; rua=mailto:you@…`). Gmail and Yahoo penalise senders without one.
- [ ] Send yourself a sign-in link and a "Down" alert at Gmail, Outlook and one company address. None lands in spam.
- [ ] Resend plan covers expected volume (free tier: 3,000 emails a month, 100 a day). Move to a paid tier or Postmark before you approach it.
- [ ] Add a Slack channel and a Discord channel to your own account and use **Send test** on each.

## 4. Legal and trust

- [ ] **(blocker)** Terms of Service and Privacy Policy pages exist and are linked from the landing and sign-in pages.
- [ ] **(blocker)** The privacy policy says plainly what is stored: email address, check settings, ping timestamps and counts, payload field **names and types** (never values), and alert webhook URLs (encrypted). Payments are handled by Stripe.
- [ ] State the retention periods: 30 days of ping history, 12 months of daily counts.
- [ ] A support email address exists (e.g. `support@stepcanary.com`) and is monitored. Cloudflare Email Routing can forward it to your inbox for free.
- [ ] Decide your refund policy and state it.
- [ ] If you will sell to EU customers: list your sub-processors (Cloudflare, Neon, Resend, Stripe) and have a data-processing agreement available. Get a lawyer's view; this checklist is not legal advice.

## 5. The product explains itself

- [ ] **(blocker)** The landing page says what it does, who it is for, and shows pricing.
- [ ] Pricing on the landing page matches the Plan page and the Stripe prices.
- [ ] Sign up with a brand-new email address and create a first check without reading any docs. Note every place you hesitated and fix the wording.
- [ ] The "from" name and address on emails look right on a phone.
- [ ] Check the dashboard on a phone-sized screen.

## 6. Money and limits

- [ ] Set a billing alert in Cloudflare and a usage alert in Neon, so a surprise shows up as an email, not an invoice.
- [ ] Confirm the Neon plan's point-in-time restore window (how many days back you can restore).
- [ ] Stripe: business details, bank account and tax settings are complete, and payouts are enabled.
- [ ] Decide whether to collect sales tax/VAT (Stripe Tax can do it). Ask an accountant.

## 7. Before you announce

- [ ] Run `npm test` and `npm run build:check` one last time; deploy from a clean `main`.
- [ ] Do the smoke test in `docs/DEPLOY.md` step 7 against production once more.
- [ ] Read `docs/RUNBOOK.md` once, so the first incident is not the first time you see it.
- [ ] Do one restore drill (see `docs/MAINTENANCE.md`) so you know the restore path works.
- [ ] Have five friendly users try it for a week before a public launch. Watch `alert_deliveries` and `monitoring_gaps` for anything unexpected.

## Not in v1 (so you can answer "do you have…?")

Team accounts and permissions, SSO, public status pages, extra email recipients, SMS or phone
alerts, overnight active windows, "run took too long" alerts, an API, and integrations beyond
"add an HTTP step".
