ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none'
    CHECK (subscription_status IN ('none', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'trialing'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_stripe_customer_unique
  ON workspaces(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_stripe_subscription_unique
  ON workspaces(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
