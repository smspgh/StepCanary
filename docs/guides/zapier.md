# Monitor a Zap with StepCanary

**Time:** about 3 minutes. **You need:** a StepCanary check (its ping URL), and a Zapier plan
that includes the **Webhooks by Zapier** app. Webhooks by Zapier is a premium app, so it is not
available on Zapier's free plan.

The idea: add one last step to your Zap that tells StepCanary "I ran". If those pings stop
arriving, StepCanary emails you.

## 1. Create the check

1. In StepCanary, click **New check** and name it after the Zap, e.g. "New lead → CRM".
2. Choose how often it should run (see "Which settings should I pick?" below) and create it.
3. Leave the check page open. It shows your **ping URL** and "Listening for your first ping…".

`[ Screenshot: StepCanary check page with the ping URL and the "Listening" panel ]`

## 2. Add the step to your Zap

1. Open the Zap in the Zapier editor.
2. Click the **+** below the **last** step.
3. Search for and choose **Webhooks by Zapier**.
4. For **Action event**, choose **POST**, then **Continue**.

`[ Screenshot: Zapier editor, choosing Webhooks by Zapier with event POST ]`

## 3. Copy these settings

| Field | What to enter |
|---|---|
| **URL** | Your ping URL, e.g. `https://ping.stepcanary.com/p/…` |
| **Payload Type** | `json` |
| **Data** | Optional. See "Watch the data too" below. Leave empty for a simple heartbeat. |
| **Wrap Request In Array** | `No` |
| **Unflatten** | `Yes` |
| **Basic Auth**, **Headers**, **File** | Leave empty |

`[ Screenshot: Webhooks by Zapier POST step with URL and Payload Type filled in ]`

## 4. Test it

1. Click **Test step** in Zapier.
2. Look at the StepCanary check page. Within a couple of seconds it changes to
   **"Connected! First ping received"**. No refresh needed.
3. **Publish** the Zap.

`[ Screenshot: StepCanary check page showing "Connected! First ping received" ]`

That is all. StepCanary sends no alerts until the first ping has arrived, so nothing can fire
while you are still setting up.

## Which settings should I pick?

| Your Zap… | Use |
|---|---|
| Runs on a schedule (e.g. every morning at 9) | **Schedule** mode with the same times, and 15-30 minutes of grace. Zapier's schedule trigger can start a few minutes late. |
| Polls for new items (most Zapier triggers) and normally finds something every hour or so | **Interval** mode. Pick an interval comfortably longer than the longest normal quiet spell. |
| Only gets activity in business hours (lead forms, bookings) | **Interval** mode with an **active window**, e.g. Mon-Fri 09:00-18:00, so nights and weekends never alert. |
| Runs dozens or hundreds of times a day | **Volume** mode: StepCanary learns what is normal for each weekday and tells you when it drops. |

Remember that the ping only happens when the Zap **runs to the end**. A polling Zap that finds
nothing new does not run, so does not ping. Choose the interval with that in mind.

## Watch the data too (optional, Pro)

Zaps often keep running while a mapped field quietly goes blank. To catch that:

1. In the **Data** section of the webhook step, add a row for each field you care about:
   type a name on the left (e.g. `email`) and map the real field from an earlier step on the right.
2. In StepCanary, edit the check and tick **"Alert me when the data it sends changes shape"**.

StepCanary only looks at field names and whether each one is filled in, blank, or a different
type. It never stores the values.

`[ Screenshot: Data section of the webhook step with two mapped fields ]`

## Report failures straight away (optional)

By default you find out about a failure when the pings stop. If you use Zapier's per-step
**error handler** (on plans that have it), add a Webhooks by Zapier **POST** step on the error
path with the URL `…/p/your-token/fail`. StepCanary then alerts immediately instead of waiting.

## Troubleshooting

| Problem | What to check |
|---|---|
| The check stays on "Listening…" after Test step | The URL must be the whole ping URL with nothing added or missing. Copy it again with the **Copy** button. |
| Zapier shows a 404 for the step | The URL is not a valid ping URL. Copy it again from the check page. |
| "Malformed payload" warning on the check | A mapped value contains a character that broke the JSON. The ping still counted. Setting Payload Type to `json` and using the Data rows (not a hand-typed body) avoids this. |
| Alerts when the Zap is fine | The interval is shorter than a normal quiet spell. Lengthen it, add an active window, or switch to Volume mode. |
| "Runaway loop detected" | The Zap is running more than 60 times a minute. Check for a Zap that triggers itself. |
| Filters or Paths in the Zap | Steps after a Filter that stops, or on a Path that was not taken, do not run. Put the ping step where it will run for every case you count as "working". |
