-- What Stripe has scheduled for the subscription, so the Plan page can say so:
--   plan_cancel_at  the subscription is canceled and ends at this time (plan becomes Free)
--   plan_change_*   a plan switch (e.g. a downgrade) that takes effect at the end of the period
ALTER TABLE accounts
  ADD COLUMN plan_cancel_at timestamptz,
  ADD COLUMN plan_change_to text,
  ADD COLUMN plan_change_at timestamptz;
