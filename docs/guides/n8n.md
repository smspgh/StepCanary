# Monitor an n8n workflow with StepCanary

**Time:** about 3 minutes. **You need:** a StepCanary check (its ping URL) and an n8n workflow,
on n8n Cloud or self-hosted. A self-hosted instance must be able to make outbound HTTPS requests.

The idea: add one last node to your workflow that tells StepCanary "I ran". If those pings stop
arriving, StepCanary emails you.

## 1. Create the check

1. In StepCanary, click **New check** and name it after the workflow.
2. Choose how often it should run (see "Which settings should I pick?" below) and create it.
3. Leave the check page open. It shows your **ping URL** and "Listening for your first ping…".

`[ Screenshot: StepCanary check page with the ping URL and the "Listening" panel ]`

## 2. Add the node

1. Open the workflow in the n8n editor.
2. Click the **+** after the **last** node and add an **HTTP Request** node.

`[ Screenshot: n8n canvas with an HTTP Request node added at the end ]`

## 3. Copy these settings

**Parameters tab**

| Field | What to enter |
|---|---|
| **Method** | `POST` |
| **URL** | Your ping URL, e.g. `https://ping.stepcanary.com/p/…` |
| **Authentication** | `None` |
| **Send Query Parameters**, **Send Headers** | Off |
| **Send Body** | On |
| **Body Content Type** | `JSON` |
| **Specify Body** | `Using JSON` |
| **JSON** | `{"status":"ok"}` |

**Settings tab**

| Field | What to enter |
|---|---|
| **On Error** | `Continue` |
| **Retry On Fail** | On, 2 tries (optional) |

Setting **On Error** to `Continue` means that if StepCanary were ever unreachable, your
workflow would still finish normally. Monitoring should never be the thing that breaks it.

`[ Screenshot: HTTP Request node parameters ]`
`[ Screenshot: HTTP Request node Settings tab with On Error = Continue ]`

## 4. Test it

1. Click **Execute step** (called "Test step" or "Execute node" in some versions).
2. Look at the StepCanary check page. Within a couple of seconds it changes to
   **"Connected! First ping received"**.
3. Save the workflow and make sure it is **Active**.

`[ Screenshot: StepCanary check page showing "Connected! First ping received" ]`

StepCanary sends no alerts until the first ping has arrived.

## Which settings should I pick?

| Your workflow… | Use |
|---|---|
| Starts from a **Schedule Trigger** | **Schedule** mode with the same cron expression and timezone as the trigger, and 5-10 minutes of grace. |
| Starts from a **Webhook** or app trigger with steady traffic | **Interval** mode, longer than the longest normal quiet spell. |
| Only gets traffic in business hours | **Interval** mode with an **active window**. |
| Handles many executions a day | **Volume** mode. |

If the workflow has an **IF** or **Switch** node, the ping only happens on branches that reach
the HTTP Request node. Connect every branch you count as "working" to it.

## Watch the data too (optional, Pro)

To be told when a field goes blank or missing:

1. Change **Specify Body** to `Using Fields Below` and add one row per field you care about,
   with an expression as the value, e.g. name `email`, value `{{ $json.email }}`.
2. In StepCanary, edit the check and tick **"Alert me when the data it sends changes shape"**.

Using fields (not hand-written JSON) lets n8n escape quotes and line breaks for you.
StepCanary only looks at field names and whether each is filled in, blank or a different type.
It never stores the values.

`[ Screenshot: Body parameters with mapped fields ]`

## Report failures straight away (optional)

n8n can run a separate workflow whenever this one fails.

1. Create a new workflow with an **Error Trigger** node followed by an **HTTP Request** node:
   Method `POST`, URL `…/p/your-token/fail`.
2. Save it.
3. In the workflow you are monitoring, open **Settings** (the ⋯ menu) and choose that workflow
   as the **Error Workflow**.

StepCanary then alerts as soon as an execution fails, instead of waiting for pings to stop.
One error workflow per monitored workflow keeps the tokens separate.

`[ Screenshot: workflow settings with Error Workflow selected ]`

## Troubleshooting

| Problem | What to check |
|---|---|
| The check stays on "Listening…" after executing the node | Check the node's output panel for the response. `{"ok":true}` means it reached us; then confirm you are looking at the right check. |
| The node returns 404 | The URL is not a valid ping URL. Copy it again from the check page. |
| Connection or timeout errors on self-hosted n8n | The server cannot reach the internet over HTTPS. Check its firewall or proxy settings. |
| Alerts when the workflow is fine | The interval is shorter than a normal quiet spell, or the Schedule mode timezone differs from the trigger's. |
| "Runaway loop detected" | The node runs once per item for a large batch. Open the node's **Settings** and turn on **Execute Once**, or put it after the loop. |
