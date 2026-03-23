CREATE TABLE IF NOT EXISTS guest_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  offer_id UUID NOT NULL REFERENCES public_offers(id),
  actor_type TEXT NOT NULL
    CHECK (actor_type IN ('guest_agent', 'guest_human')),
  status TEXT NOT NULL
    CHECK (status IN ('pending_approval', 'payment_required', 'activated', 'rejected', 'revoked', 'expired')),
  approval_status TEXT
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approval_reference TEXT,
  approval_decided_by_user_id UUID REFERENCES users(id),
  approval_decided_at TIMESTAMPTZ,
  requester_public_key TEXT NOT NULL,
  requester_public_key_hash TEXT NOT NULL,
  guest_subject_hash TEXT NOT NULL,
  requester_label TEXT,
  purpose TEXT NOT NULL,
  delivery_mode TEXT NOT NULL
    CHECK (delivery_mode IN ('human', 'agent', 'either')),
  payment_policy TEXT NOT NULL
    CHECK (payment_policy IN ('free', 'always_x402', 'quota_then_x402')),
  price_usd_cents BIGINT NOT NULL DEFAULT 0,
  included_free_uses INTEGER NOT NULL DEFAULT 0,
  resolved_secret_name TEXT NOT NULL,
  allowed_fulfiller_id TEXT,
  status_token TEXT NOT NULL,
  policy_snapshot_json JSONB NOT NULL,
  settled_policy_snapshot_json JSONB,
  payment_quote_json JSONB,
  request_id TEXT,
  exchange_id TEXT,
  activated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (price_usd_cents >= 0),
  CHECK (included_free_uses >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_intents_status_token_unique
  ON guest_intents(status_token);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_intents_approval_reference_unique
  ON guest_intents(approval_reference)
  WHERE approval_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_intents_active_unpaid_subject
  ON guest_intents(offer_id, guest_subject_hash)
  WHERE status IN ('pending_approval', 'payment_required');

CREATE INDEX IF NOT EXISTS idx_guest_intents_workspace_created
  ON guest_intents(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_guest_intents_offer_created
  ON guest_intents(offer_id, created_at DESC);
