CREATE TABLE IF NOT EXISTS agent_allowances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  monthly_budget_cents BIGINT NOT NULL DEFAULT 0,
  current_spend_cents BIGINT NOT NULL DEFAULT 0,
  budget_reset_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now() AT TIME ZONE 'UTC') + INTERVAL '1 month',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, agent_id)
);

CREATE TABLE IF NOT EXISTS workspace_exchange_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_month DATE NOT NULL,
  free_exchange_used INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, usage_month)
);

CREATE TABLE IF NOT EXISTS x402_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  quoted_amount_cents BIGINT NOT NULL,
  quoted_currency TEXT NOT NULL DEFAULT 'USD',
  quoted_asset_symbol TEXT NOT NULL DEFAULT 'USDC',
  quoted_asset_amount TEXT NOT NULL,
  scheme TEXT NOT NULL,
  network_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  tx_hash TEXT,
  facilitator_url TEXT,
  quote_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'settled', 'failed')),
  settled_at TIMESTAMPTZ,
  response_cache JSONB,
  response_cache_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, payment_id)
);

CREATE TABLE IF NOT EXISTS x402_inflight (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id),
  UNIQUE (workspace_id, payment_id)
);
