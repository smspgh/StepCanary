# Monitor a Make scenario with StepCanary

**Time:** about 3 minutes. **You need:** a StepCanary check (its ping URL) and a Make scenario.

**New to StepCanary?** A check is our watch on one automation: it listens for a signal each time the
automation runs and alerts you when the signals stop. [What is a check?](/guides/checks)

The idea: add one last module to your scenario that tells StepCanary "I ran." If those pings
stop arriving, StepCanary emails you.

**What it costs you in Make:** the extra module uses one credit each time it runs.

## 1. Create the check

1. In StepCanary, click **New check** and name it after the scenario.
2. Choose how often it should run (see "Which settings should I pick?" below) and create it.
3. Leave the check page open. It shows your **ping URL** and "Listening for your first ping…".

`[ Screenshot: StepCanary check page with the ping URL and the "Listening" panel ]`

## 2. Add the module

1. Open the scenario in the Make editor.
2. Click the **+** after the **last** module.
3. Search for **HTTP** and choose **Make a request**.

`[ Screenshot: Make editor, adding the HTTP "Make a request" module at the end ]`

## 3. Copy these settings

Make has two versions of its HTTP app, and the field names differ. The version is shown in the
upper-right corner of the module's settings (**V4**, or **Version 3** for the older one).

**HTTP (V4, the current version)**

| Field | What to enter |
|---|---|
| **Authentication type** | `No authentication` |
| **URL** | Your ping URL, e.g. `https://ping.stepcanary.com/p/…` |
| **Method** | `POST` |
| **Headers**, **Query parameters** | Leave empty |
| **Body content type** | `application/JSON` |
| **Body input method** | `JSON string` |
| **Body content** | `{"status":"ok"}` |
| **Parse response** | `No` |

**HTTP (Version 3, legacy)**

| Field | What to enter |
|---|---|
| **URL** | Your ping URL |
| **Method** | `POST` |
| **Headers**, **Query String** | Leave empty |
| **Body type** | `Raw` |
| **Content type** | `JSON (application/json)` |
| **Request content** | `{"status":"ok"}` |
| **Parse response** | `No` |

`[ Screenshot: HTTP "Make a request" module (V4) with the settings above ]`

## 4. Test it

1. Click **Run once**.
2. Look at the StepCanary check page. Within a couple of seconds it changes to
   **"Connected! First ping received."**
3. Save the scenario and switch it to **Active** with the toggle at the top right.

`[ Screenshot: StepCanary check page showing "Connected! First ping received" ]`

StepCanary sends no alerts until the first ping has arrived.

## Which settings should I pick?

| Your scenario… | Use |
|---|---|
| Runs at set times | **Schedule** mode with the same times and 10-15 minutes of grace. |
| Runs every N minutes and always completes | **Interval** mode, a little longer than the scenario's own interval. |
| Is triggered instantly by a webhook, mostly in business hours | **Interval** mode with an **active window**. |
| Processes many items a day | **Volume** mode. |

If the first module returns nothing (no bundles), Make ends the scenario there, so the ping
module doesn't run. That means the ping only happens on runs that had something to do. Pick an
interval that allows for quiet runs.

## Watch the data too (optional, Pro)

To be told when a mapped field goes blank or missing:

1. In the HTTP module (V4), set **Body input method** to `Data structure` and add the fields you
   care about, mapping each value from an earlier module. Make builds valid JSON for you, even
   when a value contains quotes or line breaks.
2. In StepCanary, edit the check and turn on **"Alert me when the data it sends changes shape."**

On the legacy Version 3 module, set **Body type** to `Application/x-www-form-urlencoded` and add
the fields as key/value rows instead.

StepCanary only looks at field names and whether each is filled in, blank, or a different type.
It never stores the values.

`[ Screenshot: HTTP module body with mapped fields ]`

## Report failures right away (optional)

1. Right-click the module most likely to fail and choose **Add error handler**.
2. On the error route, add another **HTTP → Make a request** module with the same settings, but
   the URL `…/p/your-token/fail`.
3. End the error route with the error handler you normally use.

StepCanary then alerts as soon as the error route runs, instead of waiting for pings to stop.

`[ Screenshot: error handler route with an HTTP module pointing at /fail ]`

## Troubleshooting

| Problem | What to check |
|---|---|
| The check stays on "Listening…" after Run once | Did the run reach the HTTP module? Check the bubble above it. Then check the URL is the whole ping URL. |
| The HTTP module shows a 404 | The URL is not a valid ping URL. Copy it again from the check page. |
| "Malformed payload" on the check | A mapped value broke the JSON. The ping still counted. Use `Data structure` as the body input method (see "Watch the data too"). |
| Alerts when the scenario is fine | The interval is too short for runs that have nothing to process. Lengthen it or add an active window. |
| "Runaway loop detected" | The scenario is pinging more than 60 times a minute, usually because the HTTP module sits after an iterator and runs once per item. Move it after the aggregator, or to the end of the scenario. |
