CREATE TABLE IF NOT EXISTS guest_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  intent_id UUID NOT NULL REFERENCES guest_intents(id),
  payment_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  quoted_amount_cents BIGINT NOT NULL,
  quoted_currency TEXT NOT NULL DEFAULT 'USD',
  quoted_asset_symbol TEXT NOT NULL DEFAULT 'USDC',
  quoted_asset_amount TEXT NOT NULL,
  scheme TEXT NOT NULL,
  network_id TEXT NOT NULL,
  tx_hash TEXT,
  facilitator_url TEXT,
  payer_address TEXT,
  quote_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'settled', 'failed')),
  response_cache JSONB,
  response_cache_expires_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_guest_payments_intent_created
  ON guest_payments(intent_id, created_at DESC);
