# What is a check?

A **check** is StepCanary's watch on one of your automations. You create one check for each Zap,
scenario, or workflow you care about, and that check's only job is to notice when the automation
stops behaving normally and tell you.

## What a check does

1. **It gives you a private URL**, called the ping URL. Nobody else has it.
2. **Your automation calls that URL every time it finishes.** You add one HTTP step at the end of
   the automation to do this. Each call is a "ping," and it means "I just ran."
3. **The check knows what normal looks like.** You tell it ("this should run at least every two
   hours"), or it learns by watching for two weeks.
4. **When normal stops, the check alerts you.** If the pings stop arriving, arrive far less often
   than usual, or start carrying blank data, you get an email, Slack, or Discord message that says
   which automation, what was expected, and what happened.

Think of a check as a coworker who expects a quick "done" message from your automation on a
regular basis, and who comes to find you when the message doesn't show up.

## Why you need one

Automation tools are good at telling you when a step **fails with an error**. They are bad at
telling you when nothing happens at all, because silence isn't an error:

- Someone turned the automation off, or it was paused after a billing problem.
- A connected account expired, so the trigger quietly stopped firing.
- A form was edited, and now every run sends an empty email field to your CRM.
- A filter was changed, and only a tenth of the usual records get through.

In every one of these cases the tool shows no errors and sends no warning. You usually find out
days later, when a customer asks why nobody called them back. A check turns that silence into an
alert within minutes.

## What a check never does

- **It never signs in to your tools.** There is nothing to connect or authorize. The automation
  calls us; we never call it.
- **It never stores your data.** By default a check records only when each ping arrived. If you
  turn on payload monitoring, it also records field names and whether each field was filled in,
  never the contents.
- **It never changes, runs, or repairs your automation.** It only watches and reports.
- **It never slows your automation down.** The extra step is one small web request that is
  answered right away.

## Quick reference

| Term | What it means |
|---|---|
| **Check** | StepCanary's watch on one automation. One check per Zap, scenario, or workflow. |
| **Ping** | The signal your automation sends each time it finishes: "I just ran." |
| **Ping URL** | The private web address a check listens on. You paste it into the HTTP step. |
| **Interval** | "This should ping at least every X." The simplest way to describe normal. |
| **Schedule** | "This should ping at these set times," for automations that run on a timetable. |
| **Volume** | "This runs a lot; learn what's normal and tell me when it drops." |
| **Grace period** | Extra time a check waits after a ping is due before it alerts you. |
| **Active window** | The days and hours a check counts. Outside them its timer is paused, so quiet nights and weekends never alert. |
| **Payload shape** | The names of the fields your automation sends, and whether each is filled in. Never the values. |
| **Alert channel** | Where alerts go: email, Slack, Discord, or a webhook. |
| **Monitoring gap** | A period when StepCanary itself couldn't vouch for its monitoring. We show this instead of sending an alert that might be false. |

## What the statuses mean

| Status | What it means |
|---|---|
| **New** | The check is waiting for its first ping. It never alerts in this state. |
| **Up** | Pings are arriving as expected. |
| **Late** | A ping is overdue, but still inside the grace period. No alert yet. |
| **Down** | The grace period ran out, or the automation reported a failure. You have been alerted. |
| **Paused** | You (or a plan change) switched the check off. It keeps its history and sends no alerts. |

## How many checks do I need?

One for each automation whose silence would cost you something: lead capture, order syncing,
invoicing, client reporting. A check that is paused doesn't count against your plan.

## Set one up

Pick your tool: [Zapier](/guides/zapier), [Make](/guides/make), [n8n](/guides/n8n), or
[Pipedream](/guides/pipedream). Each guide takes about three minutes.
