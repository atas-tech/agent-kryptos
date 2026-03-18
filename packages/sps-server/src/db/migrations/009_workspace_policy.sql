CREATE TABLE IF NOT EXISTS workspace_policy_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL
    CHECK (version > 0),
  secret_registry_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(secret_registry_json) = 'array'),
  exchange_policy_json JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(exchange_policy_json) = 'array'),
  updated_by_user_id UUID REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('bootstrap', 'env_seed', 'manual', 'test')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_policy_documents_workspace_version_unique
  ON workspace_policy_documents(workspace_id, version);

CREATE INDEX IF NOT EXISTS idx_workspace_policy_documents_workspace_latest
  ON workspace_policy_documents(workspace_id, version DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_workspace_policy_updated_by_same_workspace'
  ) THEN
    ALTER TABLE workspace_policy_documents
      ADD CONSTRAINT fk_workspace_policy_updated_by_same_workspace
      FOREIGN KEY (updated_by_user_id, workspace_id)
      REFERENCES users(id, workspace_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
