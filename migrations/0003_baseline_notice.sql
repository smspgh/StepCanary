-- When we emailed the account owner that a learned volume baseline is ready to review.
-- NULL while learning; set once the email is sent (or when the user relearns by hand).
ALTER TABLE checks ADD COLUMN baseline_notified_at timestamptz;
