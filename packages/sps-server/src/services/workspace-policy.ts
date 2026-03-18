import type { Pool, PoolClient } from "pg";
import type { DbExecutor } from "../db/index.js";
import { ExchangePolicyEngine, type ExchangePolicyRule, type SecretRegistryEntry } from "./policy.js";

const SECRET_NAME_PATTERN = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const MAX_SECRET_REGISTRY_ENTRIES = 256;
const MAX_EXCHANGE_RULES = 512;
const MAX_LIST_VALUES = 64;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_CLASSIFICATION_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_REASON_LENGTH = 500;

export type WorkspacePolicySource = "bootstrap" | "env_seed" | "manual" | "test";

interface WorkspacePolicyRow {
  id: string;
  workspace_id: string;
  version: number;
  secret_registry_json: unknown;
  exchange_policy_json: unknown;
  updated_by_user_id: string | null;
  source: WorkspacePolicySource;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspacePolicyDocumentInput {
  secretRegistry: SecretRegistryEntry[];
  exchangePolicyRules: ExchangePolicyRule[];
}

export interface WorkspacePolicyRecord extends WorkspacePolicyDocumentInput {
  id: string;
  workspaceId: string;
  version: number;
  updatedByUserId: string | null;
  source: WorkspacePolicySource;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspacePolicyValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface PersistWorkspacePolicyOptions {
  expectedVersion?: number;
  source?: WorkspacePolicySource;
  updatedByUserId?: string | null;
}

export class WorkspacePolicyServiceError extends Error {
  statusCode: number;
  code: string;
  issues?: WorkspacePolicyValidationIssue[];

  constructor(statusCode: number, code: string, message: string, issues?: WorkspacePolicyValidationIssue[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.issues = issues;
  }
}

function hostedModeEnabledFromEnv(): boolean {
  const raw = process.env.SPS_HOSTED_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(values: unknown, path: string, issues: WorkspacePolicyValidationIssue[]): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }

  if (!Array.isArray(values)) {
    issues.push({
      path,
      code: "invalid_type",
      message: "must be an array of strings"
    });
    return undefined;
  }

  if (values.length > MAX_LIST_VALUES) {
    issues.push({
      path,
      code: "too_many_items",
      message: `must contain at most ${MAX_LIST_VALUES} items`
    });
  }

  const normalized: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = trimString(values[index]);
    if (!item) {
      issues.push({
        path: `${path}[${index}]`,
        code: "invalid_value",
        message: "must be a non-empty string"
      });
      continue;
    }

    if (item.length > MAX_IDENTIFIER_LENGTH) {
      issues.push({
        path: `${path}[${index}]`,
        code: "too_long",
        message: `must be at most ${MAX_IDENTIFIER_LENGTH} characters`
      });
      continue;
    }

    normalized.push(item);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSecretRegistry(
  entries: unknown,
  issues: WorkspacePolicyValidationIssue[]
): SecretRegistryEntry[] {
  if (!Array.isArray(entries)) {
    issues.push({
      path: "secretRegistry",
      code: "invalid_type",
      message: "must be an array"
    });
    return [];
  }

  if (entries.length > MAX_SECRET_REGISTRY_ENTRIES) {
    issues.push({
      path: "secretRegistry",
      code: "too_many_items",
      message: `must contain at most ${MAX_SECRET_REGISTRY_ENTRIES} entries`
    });
  }

  const normalized: SecretRegistryEntry[] = [];
  const seenSecretNames = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const raw = entries[index];
    if (!raw || typeof raw !== "object") {
      issues.push({
        path: `secretRegistry[${index}]`,
        code: "invalid_type",
        message: "must be an object"
      });
      continue;
    }

    const record = raw as Record<string, unknown>;
    const secretName = trimString(record.secretName);
    const classification = trimString(record.classification);
    const description = record.description === undefined ? undefined : trimString(record.description);

    if (!SECRET_NAME_PATTERN.test(secretName)) {
      issues.push({
        path: `secretRegistry[${index}].secretName`,
        code: "invalid_secret_name",
        message: "must match ^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$"
      });
    }

    if (!classification) {
      issues.push({
        path: `secretRegistry[${index}].classification`,
        code: "required",
        message: "must not be blank"
      });
    } else if (classification.length > MAX_CLASSIFICATION_LENGTH) {
      issues.push({
        path: `secretRegistry[${index}].classification`,
        code: "too_long",
        message: `must be at most ${MAX_CLASSIFICATION_LENGTH} characters`
      });
    }

    if (description && description.length > MAX_DESCRIPTION_LENGTH) {
      issues.push({
        path: `secretRegistry[${index}].description`,
        code: "too_long",
        message: `must be at most ${MAX_DESCRIPTION_LENGTH} characters`
      });
    }

    if (secretName) {
      if (seenSecretNames.has(secretName)) {
        issues.push({
          path: `secretRegistry[${index}].secretName`,
          code: "duplicate_secret_name",
          message: "must be unique within a workspace policy"
        });
      }
      seenSecretNames.add(secretName);
    }

    normalized.push({
      secretName,
      classification,
      description: description || undefined
    });
  }

  return normalized;
}

function normalizeExchangePolicyRules(
  rules: unknown,
  knownSecretNames: Set<string>,
  issues: WorkspacePolicyValidationIssue[]
): ExchangePolicyRule[] {
  if (!Array.isArray(rules)) {
    issues.push({
      path: "exchangePolicyRules",
      code: "invalid_type",
      message: "must be an array"
    });
    return [];
  }

  if (rules.length > MAX_EXCHANGE_RULES) {
    issues.push({
      path: "exchangePolicyRules",
      code: "too_many_items",
      message: `must contain at most ${MAX_EXCHANGE_RULES} entries`
    });
  }

  const normalized: ExchangePolicyRule[] = [];
  const seenRuleIds = new Set<string>();

  for (let index = 0; index < rules.length; index += 1) {
    const raw = rules[index];
    if (!raw || typeof raw !== "object") {
      issues.push({
        path: `exchangePolicyRules[${index}]`,
        code: "invalid_type",
        message: "must be an object"
      });
      continue;
    }

    const record = raw as Record<string, unknown>;
    const ruleId = trimString(record.ruleId);
    const secretName = trimString(record.secretName);
    const mode = trimString(record.mode);
    const reason = record.reason === undefined ? undefined : trimString(record.reason);
    const approvalReference = record.approvalReference;

    if (!ruleId) {
      issues.push({
        path: `exchangePolicyRules[${index}].ruleId`,
        code: "required",
        message: "must not be blank"
      });
    } else if (ruleId.length > MAX_IDENTIFIER_LENGTH) {
      issues.push({
        path: `exchangePolicyRules[${index}].ruleId`,
        code: "too_long",
        message: `must be at most ${MAX_IDENTIFIER_LENGTH} characters`
      });
    } else if (seenRuleIds.has(ruleId)) {
      issues.push({
        path: `exchangePolicyRules[${index}].ruleId`,
        code: "duplicate_rule_id",
        message: "must be unique within a workspace policy"
      });
    }

    if (ruleId) {
      seenRuleIds.add(ruleId);
    }

    if (!SECRET_NAME_PATTERN.test(secretName)) {
      issues.push({
        path: `exchangePolicyRules[${index}].secretName`,
        code: "invalid_secret_name",
        message: "must match ^[a-z0-9_]+(?:\\.[a-z0-9_]+)+$"
      });
    } else if (!knownSecretNames.has(secretName)) {
      issues.push({
        path: `exchangePolicyRules[${index}].secretName`,
        code: "unknown_secret_name",
        message: "must reference a declared secret registry entry"
      });
    }

    if (mode && mode !== "allow" && mode !== "pending_approval" && mode !== "deny") {
      issues.push({
        path: `exchangePolicyRules[${index}].mode`,
        code: "invalid_mode",
        message: "must be one of allow, pending_approval, or deny"
      });
    }

    if (reason && reason.length > MAX_REASON_LENGTH) {
      issues.push({
        path: `exchangePolicyRules[${index}].reason`,
        code: "too_long",
        message: `must be at most ${MAX_REASON_LENGTH} characters`
      });
    }

    if (approvalReference !== undefined && approvalReference !== null && trimString(approvalReference)) {
      issues.push({
        path: `exchangePolicyRules[${index}].approvalReference`,
        code: "disallowed_field",
        message: "approvalReference is runtime-generated and cannot be persisted in workspace policy"
      });
    }

    normalized.push({
      ruleId,
      secretName,
      requesterIds: normalizeStringList(record.requesterIds, `exchangePolicyRules[${index}].requesterIds`, issues),
      fulfillerIds: normalizeStringList(record.fulfillerIds, `exchangePolicyRules[${index}].fulfillerIds`, issues),
      approverIds: normalizeStringList(record.approverIds, `exchangePolicyRules[${index}].approverIds`, issues),
      requesterRings: normalizeStringList(record.requesterRings, `exchangePolicyRules[${index}].requesterRings`, issues),
      fulfillerRings: normalizeStringList(record.fulfillerRings, `exchangePolicyRules[${index}].fulfillerRings`, issues),
      approverRings: normalizeStringList(record.approverRings, `exchangePolicyRules[${index}].approverRings`, issues),
      purposes: normalizeStringList(record.purposes, `exchangePolicyRules[${index}].purposes`, issues),
      allowedRings: normalizeStringList(record.allowedRings, `exchangePolicyRules[${index}].allowedRings`, issues),
      sameRing: typeof record.sameRing === "boolean" ? record.sameRing : undefined,
      mode: mode === "deny" || mode === "pending_approval" || mode === "allow" ? mode : undefined,
      reason: reason || undefined
    });
  }

  return normalized;
}

export function validateWorkspacePolicyDocument(
  input: WorkspacePolicyDocumentInput
): { ok: true; document: WorkspacePolicyDocumentInput } | { ok: false; issues: WorkspacePolicyValidationIssue[] } {
  const issues: WorkspacePolicyValidationIssue[] = [];
  const secretRegistry = normalizeSecretRegistry(input.secretRegistry, issues);
  const knownSecretNames = new Set(secretRegistry.map((entry) => entry.secretName).filter(Boolean));
  const exchangePolicyRules = normalizeExchangePolicyRules(input.exchangePolicyRules, knownSecretNames, issues);

  if (issues.length > 0) {
    return {
      ok: false,
      issues
    };
  }

  return {
    ok: true,
    document: {
      secretRegistry,
      exchangePolicyRules
    }
  };
}

function requireValidWorkspacePolicy(input: WorkspacePolicyDocumentInput): WorkspacePolicyDocumentInput {
  const validation = validateWorkspacePolicyDocument(input);
  if (!validation.ok) {
    throw new WorkspacePolicyServiceError(
      400,
      "invalid_policy_document",
      "Workspace policy document is invalid",
      validation.issues
    );
  }

  return validation.document;
}

function toWorkspacePolicyRecord(row: WorkspacePolicyRow): WorkspacePolicyRecord {
  const validated = requireValidWorkspacePolicy({
    secretRegistry: row.secret_registry_json as SecretRegistryEntry[],
    exchangePolicyRules: row.exchange_policy_json as ExchangePolicyRule[]
  });

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    secretRegistry: validated.secretRegistry,
    exchangePolicyRules: validated.exchangePolicyRules,
    updatedByUserId: row.updated_by_user_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseJsonArrayEnv<T>(envName: string): T[] {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON array`);
  }

  return parsed as T[];
}

export function loadBootstrapWorkspacePolicyFromEnv(): WorkspacePolicyDocumentInput {
  return requireValidWorkspacePolicy({
    secretRegistry: parseJsonArrayEnv<SecretRegistryEntry>("SPS_SECRET_REGISTRY_JSON"),
    exchangePolicyRules: parseJsonArrayEnv<ExchangePolicyRule>("SPS_EXCHANGE_POLICY_JSON")
  });
}

export function buildWorkspacePolicyEngine(document: WorkspacePolicyDocumentInput): ExchangePolicyEngine {
  return new ExchangePolicyEngine(document.secretRegistry, document.exchangePolicyRules);
}

async function requireWorkspaceLock(client: PoolClient, workspaceId: string): Promise<void> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM workspaces
      WHERE id = $1
      FOR UPDATE
    `,
    [workspaceId]
  );

  if (!result.rows[0]) {
    throw new WorkspacePolicyServiceError(404, "workspace_not_found", "Workspace not found");
  }
}

async function getLatestWorkspacePolicyRow(
  db: DbExecutor,
  workspaceId: string
): Promise<WorkspacePolicyRow | null> {
  const result = await db.query<WorkspacePolicyRow>(
    `
      SELECT id, workspace_id, version, secret_registry_json, exchange_policy_json, updated_by_user_id, source, created_at, updated_at
      FROM workspace_policy_documents
      WHERE workspace_id = $1
      ORDER BY version DESC
      LIMIT 1
    `,
    [workspaceId]
  );

  return result.rows[0] ?? null;
}

export async function getWorkspacePolicy(
  db: DbExecutor,
  workspaceId: string
): Promise<WorkspacePolicyRecord | null> {
  const row = await getLatestWorkspacePolicyRow(db, workspaceId);
  return row ? toWorkspacePolicyRecord(row) : null;
}

async function insertWorkspacePolicyDocument(
  client: DbExecutor,
  workspaceId: string,
  version: number,
  document: WorkspacePolicyDocumentInput,
  options: PersistWorkspacePolicyOptions = {}
): Promise<WorkspacePolicyRecord> {
  const result = await client.query<WorkspacePolicyRow>(
    `
      INSERT INTO workspace_policy_documents (
        workspace_id,
        version,
        secret_registry_json,
        exchange_policy_json,
        updated_by_user_id,
        source,
        updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, now())
      RETURNING id, workspace_id, version, secret_registry_json, exchange_policy_json, updated_by_user_id, source, created_at, updated_at
    `,
    [
      workspaceId,
      version,
      JSON.stringify(document.secretRegistry),
      JSON.stringify(document.exchangePolicyRules),
      options.updatedByUserId ?? null,
      options.source ?? "manual"
    ]
  );

  return toWorkspacePolicyRecord(result.rows[0]);
}

export async function ensureWorkspacePolicy(
  db: Pool,
  workspaceId: string,
  document: WorkspacePolicyDocumentInput,
  options: Omit<PersistWorkspacePolicyOptions, "expectedVersion"> = {}
): Promise<WorkspacePolicyRecord> {
  const validated = requireValidWorkspacePolicy(document);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await requireWorkspaceLock(client, workspaceId);
    const existing = await getLatestWorkspacePolicyRow(client, workspaceId);
    if (existing) {
      await client.query("COMMIT");
      return toWorkspacePolicyRecord(existing);
    }

    const created = await insertWorkspacePolicyDocument(client, workspaceId, 1, validated, options);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceWorkspacePolicy(
  db: Pool,
  workspaceId: string,
  document: WorkspacePolicyDocumentInput,
  options: PersistWorkspacePolicyOptions = {}
): Promise<WorkspacePolicyRecord> {
  const validated = requireValidWorkspacePolicy(document);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    await requireWorkspaceLock(client, workspaceId);
    const existing = await getLatestWorkspacePolicyRow(client, workspaceId);
    const currentVersion = existing?.version ?? 0;
    const expectedVersion = options.expectedVersion ?? currentVersion;

    if (expectedVersion !== currentVersion) {
      throw new WorkspacePolicyServiceError(
        409,
        "policy_version_conflict",
        `Workspace policy version conflict: expected ${expectedVersion}, found ${currentVersion}`
      );
    }

    const created = await insertWorkspacePolicyDocument(client, workspaceId, currentVersion + 1, validated, options);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class WorkspacePolicyEngineCache {
  private readonly cache = new Map<string, { version: number; engine: ExchangePolicyEngine }>();

  get(record: WorkspacePolicyRecord): ExchangePolicyEngine {
    const cached = this.cache.get(record.workspaceId);
    if (cached && cached.version === record.version) {
      return cached.engine;
    }

    const engine = buildWorkspacePolicyEngine(record);
    this.cache.set(record.workspaceId, {
      version: record.version,
      engine
    });
    return engine;
  }

  clear(workspaceId?: string): void {
    if (workspaceId) {
      this.cache.delete(workspaceId);
      return;
    }

    this.cache.clear();
  }
}

export interface ResolvedWorkspacePolicy {
  workspaceId?: string;
  version: number | null;
  source: WorkspacePolicySource | "override" | "bootstrap";
  engine: ExchangePolicyEngine;
  record: WorkspacePolicyRecord | null;
}

export interface WorkspacePolicyResolverOptions {
  db?: Pool | null;
  overridePolicy?: WorkspacePolicyDocumentInput | null;
  bootstrapPolicy?: WorkspacePolicyDocumentInput;
  engineCache?: WorkspacePolicyEngineCache;
}

interface WorkspaceIdRow {
  id: string;
}

export class WorkspacePolicyResolver {
  private readonly db: Pool | null;
  private readonly overridePolicy: WorkspacePolicyDocumentInput | null;
  private readonly bootstrapPolicy: WorkspacePolicyDocumentInput;
  private readonly bootstrapEngine: ExchangePolicyEngine;
  private readonly overrideEngine: ExchangePolicyEngine | null;
  private readonly engineCache: WorkspacePolicyEngineCache;
  private readonly hostedModeEnabled: boolean;

  constructor(options: WorkspacePolicyResolverOptions = {}) {
    this.db = options.db ?? null;
    this.overridePolicy = options.overridePolicy ?? null;
    this.bootstrapPolicy = options.bootstrapPolicy ?? loadBootstrapWorkspacePolicyFromEnv();
    this.bootstrapEngine = buildWorkspacePolicyEngine(this.bootstrapPolicy);
    this.overrideEngine = this.overridePolicy ? buildWorkspacePolicyEngine(this.overridePolicy) : null;
    this.engineCache = options.engineCache ?? new WorkspacePolicyEngineCache();
    this.hostedModeEnabled = hostedModeEnabledFromEnv();
  }

  async resolve(workspaceId?: string): Promise<ResolvedWorkspacePolicy> {
    if (this.overridePolicy && this.overrideEngine) {
      return {
        workspaceId,
        version: null,
        source: "override",
        engine: this.overrideEngine,
        record: null
      };
    }

    if (this.hostedModeEnabled && this.db && workspaceId) {
      const record = await getWorkspacePolicy(this.db, workspaceId);
      if (record) {
        return {
          workspaceId,
          version: record.version,
          source: record.source,
          engine: this.engineCache.get(record),
          record
        };
      }

      throw new WorkspacePolicyServiceError(
        503,
        "workspace_policy_missing",
        "Hosted workspace policy is unavailable for this workspace"
      );
    }

    return {
      workspaceId,
      version: null,
      source: "bootstrap",
      engine: this.bootstrapEngine,
      record: null
    };
  }
}

async function createInitialWorkspacePolicyDocument(
  db: DbExecutor,
  workspaceId: string,
  document: WorkspacePolicyDocumentInput,
  options: Omit<PersistWorkspacePolicyOptions, "expectedVersion"> = {}
): Promise<WorkspacePolicyRecord> {
  const validated = requireValidWorkspacePolicy(document);
  const existing = await getLatestWorkspacePolicyRow(db, workspaceId);
  if (existing) {
    return toWorkspacePolicyRecord(existing);
  }

  return insertWorkspacePolicyDocument(db, workspaceId, 1, validated, options);
}

export async function initializeWorkspacePolicy(
  db: DbExecutor,
  workspaceId: string,
  document: WorkspacePolicyDocumentInput,
  options: Omit<PersistWorkspacePolicyOptions, "expectedVersion"> = {}
): Promise<WorkspacePolicyRecord> {
  return createInitialWorkspacePolicyDocument(db, workspaceId, document, options);
}

export async function listWorkspaceIdsMissingPolicy(db: DbExecutor): Promise<string[]> {
  const result = await db.query<WorkspaceIdRow>(
    `
      SELECT w.id
      FROM workspaces w
      LEFT JOIN workspace_policy_documents wpd
        ON wpd.workspace_id = w.id
      WHERE wpd.id IS NULL
      ORDER BY w.created_at ASC, w.id ASC
    `
  );

  return result.rows.map((row) => row.id);
}

export async function seedMissingWorkspacePolicies(
  db: Pool,
  document: WorkspacePolicyDocumentInput,
  options: Omit<PersistWorkspacePolicyOptions, "expectedVersion"> = {}
): Promise<WorkspacePolicyRecord[]> {
  const workspaceIds = await listWorkspaceIdsMissingPolicy(db);
  const seeded: WorkspacePolicyRecord[] = [];

  for (const workspaceId of workspaceIds) {
    const record = await ensureWorkspacePolicy(db, workspaceId, document, options);
    seeded.push(record);
  }

  return seeded;
}
