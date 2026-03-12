CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_user_sessions_user_workspace'
  ) THEN
    ALTER TABLE user_sessions
      ADD CONSTRAINT fk_user_sessions_user_workspace
      FOREIGN KEY (user_id, workspace_id)
      REFERENCES users(id, workspace_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_workspace ON user_sessions(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_refresh_token_hash_unique ON user_sessions(refresh_token_hash);
