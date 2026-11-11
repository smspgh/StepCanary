# Monitor a Pipedream workflow with StepCanary

**Time:** about 3 minutes. **You need:** a StepCanary check (its ping URL) and a Pipedream
workflow.

The idea: add one last step to your workflow that tells StepCanary "I ran". If those pings stop
arriving, StepCanary emails you.

## 1. Create the check

1. In StepCanary, click **New check** and name it after the workflow.
2. Choose how often it should run (see "Which settings should I pick?" below) and create it.
3. Leave the check page open. It shows your **ping URL** and "Listening for your first ping…".

`[ Screenshot: StepCanary check page with the ping URL and the "Listening" panel ]`

## 2. Add the step

1. Open the workflow in the Pipedream builder.
2. Click the **+** below the **last** step.
3. Choose **HTTP / Webhook**, then **Send any HTTP Request**.

`[ Screenshot: Pipedream builder, choosing HTTP / Webhook → Send any HTTP Request ]`

## 3. Copy these settings

| Field | What to enter |
|---|---|
| **Method** | `POST` |
| **URL** | Your ping URL, e.g. `https://ping.stepcanary.com/p/…` |
| **Auth**, **Params**, **Headers** | Leave empty |
| **Body** → content type | `application/json` |
| **Body** → raw content | `{"status":"ok"}` |

`[ Screenshot: Send any HTTP Request step with method, URL and body filled in ]`

Prefer code? A Node.js step does the same thing:

```javascript
export default defineComponent({
  async run({ steps, $ }) {
    await fetch("https://ping.stepcanary.com/p/YOUR-TOKEN", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ok" }),
    });
  },
});
```

## 4. Test it

1. Click **Test** on the step.
2. Look at the StepCanary check page. Within a couple of seconds it changes to
   **"Connected! First ping received"**.
3. **Deploy** the workflow.

`[ Screenshot: StepCanary check page showing "Connected! First ping received" ]`

StepCanary sends no alerts until the first ping has arrived.

## Which settings should I pick?

| Your workflow… | Use |
|---|---|
| Starts from a **Schedule** trigger | **Schedule** mode with the same cron expression and timezone, and 5-10 minutes of grace. |
| Starts from an HTTP or app event trigger with steady traffic | **Interval** mode, longer than the longest normal quiet spell. |
| Only gets traffic in business hours | **Interval** mode with an **active window**. |
| Handles many events a day | **Volume** mode. |

If an earlier step ends the workflow early (for example with `$.flow.exit()` or a filter step),
later steps do not run and no ping is sent for that event. Place the ping step where it runs for
every case you count as "working".

## Watch the data too (optional, Pro)

To be told when a field goes blank or missing, send the fields you care about in the body. In
the HTTP step, switch the body to key/value fields and reference earlier steps, e.g. key
`email`, value `{{steps.trigger.event.body.email}}`. In a code step:

```javascript
body: JSON.stringify({
  email: steps.trigger.event.body.email,
  order_id: steps.trigger.event.body.id,
}),
```

Then edit the check in StepCanary and tick **"Alert me when the data it sends changes shape"**.
StepCanary only looks at field names and whether each is filled in, blank or a different type.
It never stores the values.

`[ Screenshot: HTTP step body with mapped fields ]`

## Report failures straight away (optional)

In a Node.js step, wrap the risky part of the workflow and report the failure before rethrowing:

```javascript
export default defineComponent({
  async run({ steps, $ }) {
    try {
      // ... your logic ...
    } catch (err) {
      await fetch("https://ping.stepcanary.com/p/YOUR-TOKEN/fail", { method: "POST" });
      throw err;
    }
  },
});
```

StepCanary then alerts immediately instead of waiting for pings to stop.

## Troubleshooting

| Problem | What to check |
|---|---|
| The check stays on "Listening…" after Test | Look at the step's result. `{"ok":true}` means it reached us; then confirm you are looking at the right check. |
| The step returns 404 | The URL is not a valid ping URL. Copy it again from the check page. |
| Alerts when the workflow is fine | The interval is shorter than a normal quiet spell, or the Schedule mode timezone differs from the trigger's. |
| "Runaway loop detected" | The workflow is running more than 60 times a minute. Check for a workflow that triggers itself, or a source emitting far more events than expected. |
