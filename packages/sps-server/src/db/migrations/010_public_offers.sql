CREATE TABLE IF NOT EXISTS public_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  offer_label TEXT,
  delivery_mode TEXT NOT NULL
    CHECK (delivery_mode IN ('human', 'agent', 'either')),
  payment_policy TEXT NOT NULL
    CHECK (payment_policy IN ('free', 'always_x402', 'quota_then_x402')),
  price_usd_cents BIGINT NOT NULL DEFAULT 0,
  included_free_uses INTEGER NOT NULL DEFAULT 0,
  secret_name TEXT,
  secret_alias TEXT,
  allowed_fulfiller_id TEXT,
  require_approval BOOLEAN NOT NULL DEFAULT false,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (price_usd_cents >= 0),
  CHECK (included_free_uses >= 0),
  CHECK (max_uses IS NULL OR max_uses > 0),
  CHECK (secret_name IS NOT NULL OR secret_alias IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_public_offers_token_hash_unique
  ON public_offers(token_hash);

CREATE INDEX IF NOT EXISTS idx_public_offers_workspace_created
  ON public_offers(workspace_id, created_at DESC);
