CREATE TABLE IF NOT EXISTS enrolled_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'deleted')),
  api_key_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CHECK (
    (status = 'active' AND api_key_hash IS NOT NULL)
    OR (status IN ('revoked', 'deleted'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrolled_agents_active_unique
  ON enrolled_agents(workspace_id, agent_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_enrolled_agents_workspace_status
  ON enrolled_agents(workspace_id, status, created_at DESC);
