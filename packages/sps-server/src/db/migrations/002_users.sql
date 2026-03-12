CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL
    CHECK (email = lower(btrim(email))),
  password_hash TEXT NOT NULL,
  force_password_change BOOLEAN NOT NULL DEFAULT false,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  verification_token TEXT,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL DEFAULT 'workspace_admin'
    CHECK (role IN ('workspace_admin', 'workspace_operator', 'workspace_viewer')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id_workspace_unique ON users(id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verification_token_unique
  ON users(verification_token)
  WHERE verification_token IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_workspaces_owner_user_same_workspace'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT fk_workspaces_owner_user_same_workspace
      FOREIGN KEY (owner_user_id, id)
      REFERENCES users(id, workspace_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
