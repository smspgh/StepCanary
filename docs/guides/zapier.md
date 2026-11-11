# Monitor a Zap with StepCanary

**Time:** about 3 minutes. **You need:** a StepCanary check (its ping URL) and a paid Zapier plan
(Professional, Team, or Enterprise). The step uses **Webhooks by Zapier**, which Zapier doesn't
include on its Free plan, and Free Zaps are limited to a trigger plus one action anyway.

**New to StepCanary?** A check is our watch on one automation: it listens for a signal each time the
automation runs and alerts you when the signals stop. [What is a check?](/guides/checks)

The idea: add one last step to your Zap that tells StepCanary "I ran." If those pings stop
arriving, StepCanary emails you.

**What it costs you in Zapier:** the extra step uses one task each time the Zap runs. Testing the
step in the editor is free.

## 1. Create the check

1. In StepCanary, click **New check** and name it after the Zap, e.g. "New lead → CRM".
2. Choose how often it should run (see "Which settings should I pick?" below) and create it.
3. Leave the check page open. It shows your **ping URL** and "Listening for your first ping…".

`[ Screenshot: StepCanary check page with the ping URL and the "Listening" panel ]`

## 2. Add the step to your Zap

1. Open the Zap in the Zapier editor.
2. Click the **+** below the **last** step.
3. Search for and choose **Webhooks by Zapier**.
4. For **Event**, choose **POST**, then **Continue**.

`[ Screenshot: Zapier editor, choosing Webhooks by Zapier with the POST event ]`

## 3. Copy these settings

| Field | What to enter |
|---|---|
| **URL** | Your ping URL, e.g. `https://ping.stepcanary.com/p/…` |
| **Payload Type** | `JSON` |
| **Data** | Optional. See "Watch the data too" below. Leave empty for a simple heartbeat. |
| **Headers**, **Basic Auth** | Leave empty |
| Any other fields | Leave them as they are |

`[ Screenshot: Webhooks by Zapier POST step with URL and Payload Type filled in ]`

## 4. Test it

1. Click **Test step** in Zapier.
2. Look at the StepCanary check page. Within a couple of seconds it changes to
   **"Connected! First ping received."** No refresh needed.
3. **Publish** the Zap.

`[ Screenshot: StepCanary check page showing "Connected! First ping received" ]`

That is all. StepCanary sends no alerts until the first ping has arrived, so nothing can fire
while you are still setting up.

## Which settings should I pick?

| Your Zap… | Use |
|---|---|
| Runs on a schedule (e.g. every morning at 9 AM) | **Schedule** mode with the same times, and 15-30 minutes of grace. Zapier's schedule trigger can start a few minutes late. |
| Polls for new items (most Zapier triggers) and normally finds something every hour or so | **Interval** mode. Pick an interval comfortably longer than the longest normal quiet spell. |
| Only gets activity in business hours (lead forms, bookings) | **Interval** mode with an **active window**, e.g. Mon–Fri, 9:00 AM–6:00 PM, so nights and weekends never alert. |
| Runs dozens or hundreds of times a day | **Volume** mode: StepCanary learns what is normal for each weekday and tells you when it drops. |

Remember that the ping only happens when the Zap **runs to the end**. A polling Zap that finds
nothing new does not run, so does not ping. Choose the interval with that in mind.

## Watch the data too (optional, Pro)

Zaps often keep running while a mapped field quietly goes blank. To catch that:

1. In the **Data** section of the webhook step, add a row for each field you care about:
   type a name on the left (e.g. `email`) and map the real field from an earlier step on the right.
2. In StepCanary, edit the check and turn on **"Alert me when the data it sends changes shape."**

StepCanary only looks at field names and whether each one is filled in, blank, or a different
type. It never stores the values.

`[ Screenshot: Data section of the webhook step with two mapped fields ]`

## Report failures right away (optional)

By default you find out about a failure when the pings stop. Zapier's **custom error handling**
(Professional plans and higher) lets you report one immediately:

1. On the step most likely to fail, open the three-dot menu and choose **Add error handler**.
2. On the error path, add a **Webhooks by Zapier** step with the **POST** event and the URL
   `…/p/your-token/fail`.

StepCanary then alerts right away instead of waiting for pings to stop. Things to know: an error
handler can't be added to the trigger or to a Paths step, turning one on switches off Zapier's
autoreplay for that Zap, and Zapier stops sending its own error emails for errors the handler
catches.

## No Webhooks by Zapier? Use a code step

If your plan includes **Code by Zapier** but you'd prefer not to use the webhook step, add a
**Code by Zapier** step with the **Run Javascript** event as the last step, and paste this:

```javascript
// Optional: add rows under "Input Data" (for example, email) to send fields to StepCanary.
const url = "https://ping.stepcanary.com/p/YOUR-TOKEN";
try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inputData || {}),
  });
  return { pinged: res.ok, status: res.status };
} catch (err) {
  return { pinged: false, error: String(err) };
}
```

The step is written so that a problem reaching StepCanary never fails your Zap. It also uses one
task per run.

## Troubleshooting

| Problem | What to check |
|---|---|
| The check stays on "Listening…" after Test step | The URL must be the whole ping URL with nothing added or missing. Copy it again with the **Copy** button. |
| Zapier shows a 404 for the step | The URL is not a valid ping URL. Copy it again from the check page. |
| "Malformed payload" warning on the check | A mapped value contains a character that broke the JSON. The ping still counted. Setting Payload Type to `JSON` and using the Data rows (not a hand-typed body) avoids this. |
| Alerts when the Zap is fine | The interval is shorter than a normal quiet spell. Lengthen it, add an active window, or switch to Volume mode. |
| "Runaway loop detected" | The Zap is running more than 60 times a minute. Check for a Zap that triggers itself. |
| Filters or Paths in the Zap | When a Filter stops a Zap, no later steps run, so no ping is sent. The same goes for steps on a Path that wasn't taken. Put the ping step where it will run for every case you count as "working." |
