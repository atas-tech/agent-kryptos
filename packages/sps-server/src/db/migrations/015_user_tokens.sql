CREATE TABLE IF NOT EXISTS user_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL
    CHECK (token_type IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_hash_unique
  ON user_tokens(token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_active_type_unique
  ON user_tokens(user_id, token_type)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_tokens_lookup_active
  ON user_tokens(token_type, token_hash)
  WHERE consumed_at IS NULL;
