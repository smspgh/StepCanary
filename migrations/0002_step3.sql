-- Step 3: volume baselines, payload drift, runaway loops, extra channels, client folders, billing.

CREATE TABLE folders (
  id                text PRIMARY KEY,
  account_id        text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- ISO week ("2026-W46") of the last weekly summary sent, so each week is sent once.
  last_summary_week text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX folders_account ON folders (account_id);

ALTER TABLE accounts ADD COLUMN stripe_subscription_id text;
CREATE UNIQUE INDEX accounts_stripe_customer ON accounts (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE channels ADD COLUMN name text;

ALTER TABLE checks DROP CONSTRAINT checks_mode_check;
ALTER TABLE checks ADD CONSTRAINT checks_mode_check CHECK (mode IN ('interval', 'schedule', 'volume'));

ALTER TABLE checks
  ADD COLUMN folder_id               text REFERENCES folders (id) ON DELETE SET NULL,
  ADD COLUMN first_ping_at           timestamptz,
  ADD COLUMN paused_reason           text,
  -- Volume mode
  ADD COLUMN volume_threshold_pct    int,
  ADD COLUMN baseline_status         text CHECK (baseline_status IN ('learning', 'ready', 'active')),
  ADD COLUMN baseline                jsonb,
  ADD COLUMN volume_evaluated_until  timestamptz,
  -- Payload drift. Shapes are { "key.path": "type|type" }: key names and types only.
  ADD COLUMN drift_enabled           boolean NOT NULL DEFAULT false,
  ADD COLUMN accepted_shape          jsonb,
  ADD COLUMN optional_paths          jsonb,
  ADD COLUMN pending_shape           jsonb,
  -- Last time the edge reported this check as rate-limited (runaway loop).
  ADD COLUMN runaway_at              timestamptz;

UPDATE checks c SET first_ping_at = p.first_at
  FROM (SELECT check_id, min(received_at) AS first_at FROM pings GROUP BY check_id) p
 WHERE p.check_id = c.id;
UPDATE checks SET first_ping_at = last_ping_at WHERE first_ping_at IS NULL AND last_ping_at IS NOT NULL;

-- Volume checks are re-evaluated while down (a ping alone does not prove volume recovered),
-- so "due" is now simply "has a next_eval_at".
DROP INDEX checks_due;
CREATE INDEX checks_due ON checks (next_eval_at) WHERE next_eval_at IS NOT NULL;
CREATE INDEX checks_folder ON checks (folder_id) WHERE folder_id IS NOT NULL;

ALTER TABLE incidents
  ADD COLUMN details       jsonb,
  ADD COLUMN last_event_at timestamptz;
