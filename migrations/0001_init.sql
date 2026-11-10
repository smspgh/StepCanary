-- StepCanary schema (Step 2 / MVP).
-- Privacy rule: no table stores payload values. `last_shape` holds key names and value types only.

CREATE TABLE accounts (
  id                 text PRIMARY KEY,
  email              text NOT NULL UNIQUE,
  plan               text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'agency')),
  stripe_customer_id text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_tokens (
  token_hash text PRIMARY KEY,
  email      text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('email', 'slack', 'discord', 'webhook')),
  config     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_account ON channels (account_id);

CREATE TABLE checks (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name               text NOT NULL,
  token              text NOT NULL UNIQUE,
  mode               text NOT NULL CHECK (mode IN ('interval', 'schedule')),
  interval_seconds   int,
  cron               text,
  timezone           text NOT NULL DEFAULT 'UTC',
  grace_seconds      int NOT NULL,
  active_window      jsonb,
  status             text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'up', 'late', 'down', 'paused')),
  status_changed_at  timestamptz,
  last_ping_at       timestamptz,
  last_start_at      timestamptz,
  last_fail_at       timestamptz,
  -- Evaluation clock restarts here (set on resume and on settings changes).
  clock_reset_at     timestamptz,
  -- When the evaluator must next look at this check. NULL = nothing scheduled.
  next_eval_at       timestamptz,
  -- Most recent payload shape: { "key.path": "type|type" }. Key names + types only, never values.
  last_shape         jsonb,
  last_shape_hash    text,
  payload_warning    text,
  payload_warning_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_account ON checks (account_id);
CREATE INDEX checks_due ON checks (next_eval_at) WHERE status IN ('up', 'late');

CREATE TABLE check_channels (
  check_id   text NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  PRIMARY KEY (check_id, channel_id)
);

-- Raw pings, kept 30 days. `id` is the ingest message id, so queue redeliveries are no-ops.
CREATE TABLE pings (
  check_id    text NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  id          text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('ok', 'fail', 'start')),
  flags       int NOT NULL DEFAULT 0,
  shape_hash  text,
  PRIMARY KEY (check_id, received_at, id)
);
CREATE INDEX pings_received ON pings (received_at);

-- Hourly counters, kept 30 days (sparkline now, volume baseline in Step 3).
CREATE TABLE ping_hourly (
  check_id text NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  hour     timestamptz NOT NULL,
  ok       int NOT NULL DEFAULT 0,
  fail     int NOT NULL DEFAULT 0,
  PRIMARY KEY (check_id, hour)
);

-- Daily counters (UTC days), kept 12 months.
CREATE TABLE ping_daily (
  check_id text NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  day      date NOT NULL,
  ok       int NOT NULL DEFAULT 0,
  fail     int NOT NULL DEFAULT 0,
  PRIMARY KEY (check_id, day)
);

CREATE TABLE incidents (
  id          text PRIMARY KEY,
  check_id    text NOT NULL REFERENCES checks (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  reason      text NOT NULL,
  opened_at   timestamptz NOT NULL,
  resolved_at timestamptz
);
-- At most one open incident per check and kind: the root of alert idempotency.
CREATE UNIQUE INDEX incidents_one_open ON incidents (check_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX incidents_check ON incidents (check_id, opened_at);

-- Alert outbox. One row per (incident, event, channel), enforced by the unique constraint.
CREATE TABLE alert_deliveries (
  id              text PRIMARY KEY,
  incident_id     text NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  event           text NOT NULL,
  channel_id      text NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  claimed_at      timestamptz,
  sent_at         timestamptz,
  last_error      text,
  subject         text NOT NULL,
  body            text NOT NULL,
  link            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, event, channel_id)
);
CREATE INDEX alert_deliveries_due ON alert_deliveries (next_attempt_at) WHERE status IN ('pending', 'sending');

-- One row per evaluator minute. Missing or unfinished rows are how we detect our own outages.
CREATE TABLE evaluator_runs (
  minute      int PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  healthy     boolean NOT NULL DEFAULT false,
  evaluated   int NOT NULL DEFAULT 0,
  transitions int NOT NULL DEFAULT 0,
  errors      int NOT NULL DEFAULT 0,
  note        text
);

-- Windows in which we could not vouch for our own monitoring. Shown on the dashboard;
-- "down" alerts are suppressed for them and evaluation clocks restart at the gap's end.
CREATE TABLE monitoring_gaps (
  id         text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz NOT NULL,
  reason     text NOT NULL
);
CREATE INDEX monitoring_gaps_ended ON monitoring_gaps (ended_at);

CREATE TABLE system_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
