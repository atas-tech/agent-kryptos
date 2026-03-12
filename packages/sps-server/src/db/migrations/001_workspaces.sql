CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL
    CHECK (slug = lower(btrim(slug)))
    CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  display_name TEXT NOT NULL
    CHECK (length(btrim(display_name)) > 0),
  tier TEXT NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'standard')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  owner_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug_unique ON workspaces(slug);
