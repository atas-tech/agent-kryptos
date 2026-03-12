CREATE TABLE audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id),
  event_type   TEXT NOT NULL,
  actor_id     TEXT,
  actor_type   TEXT CHECK (actor_type IN ('user', 'agent', 'system')),
  resource_id  TEXT,
  metadata     JSONB,
  ip_address   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_workspace_time ON audit_log(workspace_id, created_at DESC);
CREATE INDEX idx_audit_event_time ON audit_log(event_type, created_at DESC);
