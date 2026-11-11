# Step 3: rolling it out

Step 3 adds volume baselines, payload-drift alerts, runaway-loop protection, Slack / Discord /
webhook channels, client folders with a weekly summary, and Stripe billing. Commands are
PowerShell, run from the project folder.

## Part A: deploy the features (about 10 minutes, no Stripe needed)

Everything except paid upgrades works without Stripe. Until Part B is done the Plan page says
"Paid plans are not available yet" and every account stays on its current plan.

1. **Apply the schema change.** Use the same direct Neon connection string as before, in your
   own terminal:

   ```powershell
   $env:DATABASE_URL = "postgres://..."
   npm run migrate
   ```

   Expect `= 0001_init.sql (already applied)`, then `+ 0002_step3.sql`,
   `+ 0003_baseline_notice.sql` and `+ 0004_pending_plan_change.sql`. Always run migrations
   **before** deploying code that needs them. The change only adds
   tables and columns, so the currently deployed code keeps working while you do the next steps.

2. **Create the channel encryption key** and store it in your password manager as
   "StepCanary CHANNEL_KEY". Like `TOKEN_SECRET`, it must never change: it is what decrypts
   customers' Slack/Discord/webhook URLs.

   ```powershell
   npm run gen:secret
   npx wrangler secret put CHANNEL_KEY -c wrangler.app.jsonc
   ```

   Type the command exactly as shown and paste the value only at the prompt.

3. **Deploy both Workers**, ingest first (it gains the rate limiter):

   ```powershell
   npm test
   npm run deploy:ingest
   npm run deploy:app
   ```

4. **Check it.**
   - Healthchecks.io stays green.
   - `https://app.stepcanary.com` shows the new "Alert channels" and "Plan" links.
   - To try the paid features yourself before billing exists, give your own account a plan
     in the Neon SQL editor: `UPDATE accounts SET plan = 'agency' WHERE email = 'you@example.com';`

## Part B: switch on billing (about 30 minutes)

Do this first in Stripe **test mode**, try a full purchase with a test card, then repeat the
same steps in live mode.

1. **Products and prices** (Stripe → Product catalog): create two products with one recurring
   monthly price each.
   - "StepCanary Pro", $15.00 per month
   - "StepCanary Agency", $49.00 per month

   Copy each price's id (starts with `price_`).

2. **Customer portal** (Stripe → Settings → Billing → Customer portal): turn it on, and allow
   customers to switch plans between the two prices, update payment methods and cancel.
   Plan changes for existing subscribers happen here, not in our app. Two settings matter:
   - **Cancellations:** cancel at the **end of the billing period**, so customers keep what
     they paid for.
   - **Downgrades** (under plan switching, "when switching to a cheaper subscription"): choose
     **wait until end of billing period to update**. With the default ("update immediately") a
     customer who moves from Agency to Pro loses Agency features at once and gets a credit
     instead. Upgrades should stay immediate.

   The Plan page in StepCanary shows either pending change ("cancelled, active until…" or
   "changes to Pro on…") and keeps the current plan until Stripe says the period has ended.

3. **Webhook** (Stripe → Developers → Webhooks → Add endpoint):
   - URL: `https://app.stepcanary.com/webhooks/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the signing secret (starts with `whsec_`).

4. **Secrets**:

   ```powershell
   npx wrangler secret put STRIPE_SECRET_KEY -c wrangler.app.jsonc      # sk_test_... or sk_live_...
   npx wrangler secret put STRIPE_WEBHOOK_SECRET -c wrangler.app.jsonc  # whsec_...
   npx wrangler secret put STRIPE_PRICE_PRO -c wrangler.app.jsonc       # price_...
   npx wrangler secret put STRIPE_PRICE_AGENCY -c wrangler.app.jsonc    # price_...
   ```

   Setting a secret takes effect immediately; no redeploy is needed.

5. **Test purchase** (test mode): sign in, open Plan, choose Pro, pay with card
   `4242 4242 4242 4242` (any future expiry, any CVC). Within a few seconds the Plan page should
   show Pro. Then use "Manage billing" to switch to Agency, and to cancel; the plan should
   follow each time. Cancelling takes effect at the end of the paid period unless you choose
   immediate cancellation in the portal settings.

6. **Go live**: repeat steps 1-4 in live mode (new products, new webhook, live keys).

## How the new pieces behave (for support questions)

| Feature | Behaviour |
|---|---|
| Runaway loop | Above 60 pings a minute per check we answer 200 but stop queueing them, and queue one marker a minute instead. One "Runaway loop detected" alert; it closes by itself 10 minutes after the loop stops. The limit is enforced per Cloudflare location, so it is approximate. |
| Payload drift | Off by default, per check. The first payload defines normal. A change raises one alert and stays open until the user clicks "Accept new shape" or "Mark as optional". Drift never marks a check down. |
| Volume baseline | Learns for 14 full days, then emails the account owner once that the baseline is ready to review. Nothing alerts until the user turns it on. Each day is judged at 08:00 the next morning in the check's timezone, so alerts arrive at the start of the working day (checks averaging 20+ pings an hour are also judged hour by hour). Days with nothing normally expected, and days touched by a monitoring gap, are skipped. |
| Channels | New channels attach to all existing checks. Webhook URLs are encrypted and never shown again. Free accounts only ever get email. |
| Weekly summary | Agency only. One email per client folder, sent to the account owner on Mondays from 09:00 UTC, covering the previous Monday-Sunday. Not sent for a week before the folder existed. |
| Downgrade | Checks using paid features are paused first, then the least recently pinged beyond the limit. Nothing is deleted, and upgrading again resumes them. |

## Known limits of this version

- Drift and baseline actions need the user to be signed in; the alert link opens the check page
  where the buttons are, rather than acting straight from the email.
- A daily volume drop is reported the next morning at 08:00, not on the day it happens.
- Extra email recipients are not supported yet; email alerts go to the account's own address.
