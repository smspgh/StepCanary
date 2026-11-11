# Monitor a Pipedream workflow with StepCanary

**Important:** Pipedream has announced that Pipedream Workflows shuts down on March 31, 2027, and
it no longer accepts new signups. This guide is for people who already have Pipedream workflows
and want them watched until they move elsewhere.

**Time:** about 3 minutes. **You need:** a StepCanary check (its ping URL) and an existing
Pipedream workflow.

**New to StepCanary?** A check is our watch on one automation: it listens for a signal each time the
automation runs and alerts you when the signals stop. [What is a check?](/guides/checks)

The idea: add one last step to your workflow that tells StepCanary "I ran." If those pings stop
arriving, StepCanary emails you.

## 1. Create the check

1. In StepCanary, click **New check** and name it after the workflow.
2. Choose how often it should run (see "Which settings should I pick?" below) and create it.
3. Leave the check page open. It shows your **ping URL** and "Listening for your first ping…".

`[ Screenshot: StepCanary check page with the ping URL and the "Listening" panel ]`

## 2. Add the step

1. Open the workflow in the Pipedream builder.
2. Click the **+** below the **last** step.
3. Add a **Node.js** code step.

We recommend a code step over Pipedream's no-code HTTP action. With the no-code action, a
failed request cancels the whole workflow, so a problem reaching StepCanary would mark your run
as failed. The code below can't do that.

`[ Screenshot: Pipedream builder, adding a Node.js code step at the end ]`

## 3. Copy these settings

Replace the step's code with this:

```javascript
import axios from "axios";

export default defineComponent({
  async run({ steps, $ }) {
    try {
      const resp = await axios({
        method: "POST",
        url: "https://ping.stepcanary.com/p/YOUR-TOKEN",
        headers: { "Content-Type": "application/json" },
        data: { status: "ok" },
        timeout: 10000,
        validateStatus: () => true, // never throw on an error status
      });
      $.export("stepcanary_status", resp.status);
    } catch (err) {
      // Network problem or timeout: note it, and let the workflow finish normally.
      $.export("stepcanary_error", err.message);
    }
  },
});
```

| Line | What to change |
|---|---|
| `url` | Your ping URL, e.g. `https://ping.stepcanary.com/p/…` |
| `data` | Optional. See "Watch the data too" below. |

If you'd still prefer the no-code route, add **Send any HTTP Request** with method `POST`, your
ping URL, and a JSON body of `{"status":"ok"}`.

## 4. Test it

1. Click **Test** on the step.
2. Look at the StepCanary check page. Within a couple of seconds it changes to
   **"Connected! First ping received."**
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

If an earlier step ends the workflow early (for example with `return $.flow.exit()` or an
**End Workflow** step), later steps do not run and no ping is sent for that event. Place the
ping step where it runs for every case you count as "working."

## Watch the data too (optional, Pro)

To be told when a field goes blank or missing, send the fields you care about. In the code
above, change the `data` line:

```javascript
        data: {
          email: steps.trigger.event.body.email,
          order_id: steps.trigger.event.body.id,
        },
```

Then edit the check in StepCanary and turn on **"Alert me when the data it sends changes shape."**
StepCanary only looks at field names and whether each is filled in, blank, or a different type.
It never stores the values.

## Report failures right away (optional)

In a Node.js step, wrap the risky part of the workflow and report the failure before rethrowing:

```javascript
import axios from "axios";

export default defineComponent({
  async run({ steps, $ }) {
    try {
      // ... your logic ...
    } catch (err) {
      await axios.post("https://ping.stepcanary.com/p/YOUR-TOKEN/fail").catch(() => {});
      throw err;
    }
  },
});
```

StepCanary then alerts right away instead of waiting for pings to stop.

## Troubleshooting

| Problem | What to check |
|---|---|
| The check stays on "Listening…" after Test | Look at the step's exports. `stepcanary_status` of `200` means it reached us; then confirm you are looking at the right check. |
| `stepcanary_status` is `404` | The URL is not a valid ping URL. Copy it again from the check page. |
| Alerts when the workflow is fine | The interval is shorter than a normal quiet spell, or the check's timezone differs from the trigger's. |
| "Runaway loop detected" | The workflow is running more than 60 times a minute. Check for a workflow that triggers itself, or a source emitting far more events than expected. |
