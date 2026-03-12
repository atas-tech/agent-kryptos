import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import type { Pool } from "pg";
import type { WorkspaceStatus } from "./workspace.js";

const API_KEY_HASH_ROUNDS = 12;
const AGENT_TOKEN_TTL_SECONDS = 15 * 60;
const AGENT_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,160}$/;

type EnrolledAgentStatus = "active" | "revoked" | "deleted";

interface EnrolledAgentRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  display_name: string | null;
  status: EnrolledAgentStatus;
  api_key_hash: string | null;
  created_at: Date;
  revoked_at: Date | null;
  workspace_status?: WorkspaceStatus;
}

export interface EnrolledAgentRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  displayName: string | null;
  status: EnrolledAgentStatus;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AgentTokenResult {
  accessToken: string;
  accessTokenExpiresAt: number;
  agent: EnrolledAgentRecord;
}

export class AgentServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function agentJwtSecret(): Uint8Array {
  const secret = process.env.SPS_AGENT_JWT_SECRET?.trim() || "local-dev-agent-jwt-secret";
  return new TextEncoder().encode(secret);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!AGENT_ID_PATTERN.test(normalized)) {
    throw new AgentServiceError(
      400,
      "invalid_agent_id",
      "agent_id must match ^[A-Za-z0-9._:@-]{1,160}$"
    );
  }

  return normalized;
}

function normalizeDisplayName(displayName?: string | null): string | null {
  if (typeof displayName !== "string") {
    return null;
  }

  const normalized = displayName.trim();
  return normalized ? normalized : null;
}

function toAgentRecord(row: EnrolledAgentRow): EnrolledAgentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

function agentKeyPrefix(agentRowId: string): string {
  return `ak_${agentRowId}_`;
}

function generateBootstrapApiKey(agentRowId: string): string {
  return `${agentKeyPrefix(agentRowId)}${randomBytes(24).toString("base64url")}`;
}

function extractAgentRowId(apiKey: string): string | null {
  const trimmed = apiKey.trim();
  const match = /^ak_([a-f0-9-]{36})_[A-Za-z0-9_-]{20,}$/.exec(trimmed);
  return match ? match[1] : null;
}

function mapPgError(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "23505") {
      throw new AgentServiceError(409, "agent_exists", "An active agent with this agent_id already exists");
    }
  }

  throw error;
}

async function requireActiveAgentRow(db: Pool, workspaceId: string, agentId: string): Promise<EnrolledAgentRow> {
  const result = await db.query<EnrolledAgentRow>(
    `
      SELECT id, workspace_id, agent_id, display_name, status, api_key_hash, created_at, revoked_at
      FROM enrolled_agents
      WHERE workspace_id = $1
        AND agent_id = $2
        AND status = 'active'
      LIMIT 1
    `,
    [workspaceId, agentId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new AgentServiceError(404, "agent_not_found", "Agent not found");
  }

  return row;
}

export async function enrollAgent(
  db: Pool,
  workspaceId: string,
  agentId: string,
  displayName?: string | null
): Promise<{ agent: EnrolledAgentRecord; apiKey: string }> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedDisplayName = normalizeDisplayName(displayName);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const inserted = await client.query<EnrolledAgentRow>(
      `
        INSERT INTO enrolled_agents (workspace_id, agent_id, display_name, status, api_key_hash)
        VALUES ($1, $2, $3, 'active', 'pending')
        RETURNING id, workspace_id, agent_id, display_name, status, api_key_hash, created_at, revoked_at
      `,
      [workspaceId, normalizedAgentId, normalizedDisplayName]
    );

    const row = inserted.rows[0];
    const apiKey = generateBootstrapApiKey(row.id);
    const apiKeyHash = await bcrypt.hash(apiKey, API_KEY_HASH_ROUNDS);

    const updated = await client.query<EnrolledAgentRow>(
      `
        UPDATE enrolled_agents
        SET api_key_hash = $2
        WHERE id = $1
        RETURNING id, workspace_id, agent_id, display_name, status, api_key_hash, created_at, revoked_at
      `,
      [row.id, apiKeyHash]
    );

    await client.query("COMMIT");

    return {
      agent: toAgentRecord(updated.rows[0]),
      apiKey
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapPgError(error);
  } finally {
    client.release();
  }
}

export async function listAgents(db: Pool, workspaceId: string): Promise<EnrolledAgentRecord[]> {
  const result = await db.query<EnrolledAgentRow>(
    `
      SELECT id, workspace_id, agent_id, display_name, status, api_key_hash, created_at, revoked_at
      FROM enrolled_agents
      WHERE workspace_id = $1
      ORDER BY created_at DESC
    `,
    [workspaceId]
  );

  return result.rows.map(toAgentRecord);
}

export async function rotateAgentApiKey(
  db: Pool,
  workspaceId: string,
  agentId: string
): Promise<{ agent: EnrolledAgentRecord; apiKey: string }> {
  const row = await requireActiveAgentRow(db, workspaceId, normalizeAgentId(agentId));
  const apiKey = generateBootstrapApiKey(row.id);
  const apiKeyHash = await bcrypt.hash(apiKey, API_KEY_HASH_ROUNDS);
  const updated = await db.query<EnrolledAgentRow>(
    `
      UPDATE enrolled_agents
      SET api_key_hash = $2
      WHERE id = $1
      RETURNING id, workspace_id, agent_id, display_name, status, api_key_hash, created_at, revoked_at
    `,
    [row.id, apiKeyHash]
  );

  return {
    agent: toAgentRecord(updated.rows[0]),
    apiKey
  };
}

export async function revokeAgent(db: Pool, workspaceId: string, agentId: string): Promise<EnrolledAgentRecord> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const updated = await db.query<EnrolledAgentRow>(
    `
      UPDATE enrolled_agents
      SET status = 'revoked',
          revoked_at = now()
      WHERE workspace_id = $1
        AND agent_id = $2
        AND status = 'active'
      RETURNING id, workspace_id, agent_id, display_name, status, api_key_hash, created_at, revoked_at
    `,
    [workspaceId, normalizedAgentId]
  );

  const row = updated.rows[0];
  if (!row) {
    throw new AgentServiceError(404, "agent_not_found", "Agent not found");
  }

  return toAgentRecord(row);
}

export async function authenticateAgentApiKey(db: Pool, apiKey: string): Promise<EnrolledAgentRecord> {
  const trimmedApiKey = apiKey.trim();
  const agentRowId = extractAgentRowId(trimmedApiKey);
  if (!agentRowId) {
    throw new AgentServiceError(401, "invalid_api_key", "Invalid agent API key");
  }

  const result = await db.query<EnrolledAgentRow>(
    `
      SELECT
        a.id,
        a.workspace_id,
        a.agent_id,
        a.display_name,
        a.status,
        a.api_key_hash,
        a.created_at,
        a.revoked_at,
        w.status AS workspace_status
      FROM enrolled_agents a
      INNER JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.id = $1
      LIMIT 1
    `,
    [agentRowId]
  );

  const row = result.rows[0];
  if (!row || row.status !== "active" || !row.api_key_hash) {
    throw new AgentServiceError(401, "invalid_api_key", "Invalid agent API key");
  }

  const validKey = await bcrypt.compare(trimmedApiKey, row.api_key_hash);
  if (!validKey) {
    throw new AgentServiceError(401, "invalid_api_key", "Invalid agent API key");
  }

  if (row.workspace_status === "suspended") {
    throw new AgentServiceError(403, "workspace_suspended", "Workspace is suspended");
  }

  if (row.workspace_status === "deleted") {
    throw new AgentServiceError(403, "workspace_deleted", "Workspace is deleted");
  }

  return toAgentRecord(row);
}

export async function mintAgentAccessToken(agent: EnrolledAgentRecord): Promise<AgentTokenResult> {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + AGENT_TOKEN_TTL_SECONDS;
  const accessToken = await new SignJWT({
    role: "gateway",
    workspace_id: agent.workspaceId,
    workload_mode: "hosted"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("sps")
    .setAudience("sps-agent")
    .setSubject(agent.agentId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(agentJwtSecret());

  return {
    accessToken,
    accessTokenExpiresAt: expiresAt,
    agent
  };
}
