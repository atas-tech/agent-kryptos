import type { DbExecutor } from "../db/index.js";

const WORKSPACE_SLUG_PATTERN = /^[a-z0-9-]{3,40}$/;

export type WorkspaceTier = "free" | "standard";
export type WorkspaceStatus = "active" | "suspended" | "deleted";

interface WorkspaceRow {
  id: string;
  slug: string;
  display_name: string;
  tier: WorkspaceTier;
  status: WorkspaceStatus;
  owner_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceRecord {
  id: string;
  slug: string;
  displayName: string;
  tier: WorkspaceTier;
  status: WorkspaceStatus;
  ownerUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceLookupOptions {
  activeOnly?: boolean;
}

function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (!normalized) {
    throw new Error("displayName must not be blank");
  }

  return normalized;
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    tier: row.tier,
    status: row.status,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function normalizeWorkspaceSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function validateWorkspaceSlug(slug: string): boolean {
  return WORKSPACE_SLUG_PATTERN.test(slug);
}

function requireWorkspaceSlug(slug: string): string {
  const normalized = normalizeWorkspaceSlug(slug);
  if (!validateWorkspaceSlug(normalized)) {
    throw new Error("workspace slug must match ^[a-z0-9-]{3,40}$");
  }

  return normalized;
}

export async function createWorkspace(
  db: DbExecutor,
  slug: string,
  displayName: string,
  ownerUserId: string | null = null
): Promise<WorkspaceRecord> {
  const normalizedSlug = requireWorkspaceSlug(slug);
  const normalizedDisplayName = normalizeDisplayName(displayName);
  const result = await db.query<WorkspaceRow>(
    `
      INSERT INTO workspaces (slug, display_name, owner_user_id)
      VALUES ($1, $2, $3)
      RETURNING id, slug, display_name, tier, status, owner_user_id, created_at, updated_at
    `,
    [normalizedSlug, normalizedDisplayName, ownerUserId]
  );

  return toWorkspaceRecord(result.rows[0]);
}

export async function getWorkspace(
  db: DbExecutor,
  workspaceId: string,
  options: WorkspaceLookupOptions = {}
): Promise<WorkspaceRecord | null> {
  const clauses = ["id = $1"];
  if (options.activeOnly) {
    clauses.push("status = 'active'");
  }

  const result = await db.query<WorkspaceRow>(
    `
      SELECT id, slug, display_name, tier, status, owner_user_id, created_at, updated_at
      FROM workspaces
      WHERE ${clauses.join(" AND ")}
      LIMIT 1
    `,
    [workspaceId]
  );

  return result.rows[0] ? toWorkspaceRecord(result.rows[0]) : null;
}

export async function getWorkspaceBySlug(
  db: DbExecutor,
  slug: string,
  options: WorkspaceLookupOptions = {}
): Promise<WorkspaceRecord | null> {
  const normalizedSlug = requireWorkspaceSlug(slug);
  const clauses = ["slug = $1"];
  if (options.activeOnly) {
    clauses.push("status = 'active'");
  }

  const result = await db.query<WorkspaceRow>(
    `
      SELECT id, slug, display_name, tier, status, owner_user_id, created_at, updated_at
      FROM workspaces
      WHERE ${clauses.join(" AND ")}
      LIMIT 1
    `,
    [normalizedSlug]
  );

  return result.rows[0] ? toWorkspaceRecord(result.rows[0]) : null;
}

export async function updateWorkspaceTier(
  db: DbExecutor,
  workspaceId: string,
  tier: WorkspaceTier
): Promise<WorkspaceRecord | null> {
  const result = await db.query<WorkspaceRow>(
    `
      UPDATE workspaces
      SET tier = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, slug, display_name, tier, status, owner_user_id, created_at, updated_at
    `,
    [workspaceId, tier]
  );

  return result.rows[0] ? toWorkspaceRecord(result.rows[0]) : null;
}

export async function updateWorkspaceDisplayName(
  db: DbExecutor,
  workspaceId: string,
  displayName: string
): Promise<WorkspaceRecord | null> {
  const normalizedDisplayName = normalizeDisplayName(displayName);
  const result = await db.query<WorkspaceRow>(
    `
      UPDATE workspaces
      SET display_name = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, slug, display_name, tier, status, owner_user_id, created_at, updated_at
    `,
    [workspaceId, normalizedDisplayName]
  );

  return result.rows[0] ? toWorkspaceRecord(result.rows[0]) : null;
}
