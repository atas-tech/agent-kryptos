import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Pool, PoolClient } from "pg";
import { isUserRole, type UserRole } from "./rbac.js";
import type { WorkspaceRecord } from "./workspace.js";
import { createWorkspace, getWorkspace } from "./workspace.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_HASH_ROUNDS = 12;
const PASSWORD_MIN_LENGTH = 8;
const TEMPORARY_PASSWORD_MIN_LENGTH = 12;
const WEAK_TEMPORARY_PASSWORDS = new Set(["password123", "password123!", "changeme123", "temporary123"]);

export type UserStatus = "active" | "suspended" | "deleted";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  force_password_change: boolean;
  email_verified: boolean;
  verification_token: string | null;
  workspace_id: string;
  role: UserRole;
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
  workspace_slug?: string;
  workspace_display_name?: string;
  workspace_tier?: WorkspaceRecord["tier"];
  workspace_status?: WorkspaceRecord["status"];
  workspace_owner_user_id?: string | null;
  workspace_created_at?: Date;
  workspace_updated_at?: Date;
}

export interface UserRecord {
  id: string;
  email: string;
  forcePasswordChange: boolean;
  emailVerified: boolean;
  verificationToken: string | null;
  workspaceId: string;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserWithWorkspace {
  user: UserRecord;
  workspace: WorkspaceRecord;
}

export interface WorkspaceOwnerVerificationState {
  ownerUserId: string | null;
  ownerEmailVerified: boolean;
}

export interface CreateWorkspaceMemberInput {
  email: string;
  temporaryPassword: string;
  role: UserRole;
}

export interface UpdateWorkspaceMemberInput {
  role?: UserRole;
  status?: UserStatus;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

export interface AuthResult extends UserWithWorkspace {
  tokens: AuthTokens;
}

export interface SessionContext {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export class UserServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function userJwtSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.SPS_USER_JWT_SECRET?.trim() || "local-dev-user-jwt-secret");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toDateFromEpoch(seconds: number): Date {
  return new Date(seconds * 1000);
}

function normalizeIpAddress(ipAddress?: string | null): string | null {
  const normalized = ipAddress?.trim();
  return normalized ? normalized : null;
}

function normalizeUserAgent(userAgent?: string | null): string | null {
  const normalized = userAgent?.trim();
  return normalized ? normalized : null;
}

function normalizePassword(password: string): string {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new UserServiceError(400, "invalid_password", `password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  return password;
}

function normalizeTemporaryPassword(password: string): string {
  if (password.length < TEMPORARY_PASSWORD_MIN_LENGTH) {
    throw new UserServiceError(
      400,
      "invalid_temporary_password",
      `temporary password must be at least ${TEMPORARY_PASSWORD_MIN_LENGTH} characters`
    );
  }

  if (WEAK_TEMPORARY_PASSWORDS.has(password.trim().toLowerCase())) {
    throw new UserServiceError(400, "invalid_temporary_password", "temporary password is too weak");
  }

  return password;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateEmail(email: string): void {
  if (!email || !email.includes("@")) {
    throw new UserServiceError(400, "invalid_email", "email must be a valid address");
  }
}

function generateVerificationToken(): string {
  return `ver_${randomBytes(24).toString("hex")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function logVerificationUrl(email: string, verificationToken: string): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  const baseUrl = process.env.SPS_BASE_URL?.trim() || "http://localhost:3100";
  console.info(`Email verification URL for ${email}: ${baseUrl}/api/v2/auth/verify-email/${verificationToken}`);
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    forcePasswordChange: row.force_password_change,
    emailVerified: row.email_verified,
    verificationToken: row.verification_token,
    workspaceId: row.workspace_id,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireWorkspaceRecord(row: UserRow): WorkspaceRecord {
  if (!row.workspace_slug || !row.workspace_display_name || !row.workspace_tier || !row.workspace_status) {
    throw new Error("Workspace fields missing from user query");
  }

  return {
    id: row.workspace_id,
    slug: row.workspace_slug,
    displayName: row.workspace_display_name,
    tier: row.workspace_tier,
    status: row.workspace_status,
    ownerUserId: row.workspace_owner_user_id ?? null,
    createdAt: row.workspace_created_at ?? row.created_at,
    updatedAt: row.workspace_updated_at ?? row.updated_at
  };
}

async function queryUserWithWorkspaceByEmail(client: PoolClient, email: string): Promise<UserRow | null> {
  const result = await client.query<UserRow>(
    `
      SELECT
        u.id,
        u.email,
        u.password_hash,
        u.force_password_change,
        u.email_verified,
        u.verification_token,
        u.workspace_id,
        u.role,
        u.status,
        u.created_at,
        u.updated_at,
        w.slug AS workspace_slug,
        w.display_name AS workspace_display_name,
        w.tier AS workspace_tier,
        w.status AS workspace_status,
        w.owner_user_id AS workspace_owner_user_id,
        w.created_at AS workspace_created_at,
        w.updated_at AS workspace_updated_at
      FROM users u
      INNER JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.email = $1
      LIMIT 1
    `,
    [email]
  );

  return result.rows[0] ?? null;
}

async function queryUserWithWorkspaceById(client: PoolClient, userId: string): Promise<UserRow | null> {
  const result = await client.query<UserRow>(
    `
      SELECT
        u.id,
        u.email,
        u.password_hash,
        u.force_password_change,
        u.email_verified,
        u.verification_token,
        u.workspace_id,
        u.role,
        u.status,
        u.created_at,
        u.updated_at,
        w.slug AS workspace_slug,
        w.display_name AS workspace_display_name,
        w.tier AS workspace_tier,
        w.status AS workspace_status,
        w.owner_user_id AS workspace_owner_user_id,
        w.created_at AS workspace_created_at,
        w.updated_at AS workspace_updated_at
      FROM users u
      INNER JOIN workspaces w ON w.id = u.workspace_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ?? null;
}

async function queryWorkspaceOwnerVerificationState(
  client: PoolClient,
  workspaceId: string
): Promise<WorkspaceOwnerVerificationState | null> {
  const result = await client.query<{ owner_user_id: string | null; owner_email_verified: boolean | null }>(
    `
      SELECT
        w.owner_user_id,
        u.email_verified AS owner_email_verified
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.owner_user_id
      WHERE w.id = $1
      LIMIT 1
    `,
    [workspaceId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ownerUserId: row.owner_user_id,
    ownerEmailVerified: row.owner_email_verified === true
  };
}

async function listOtherActiveAdmins(client: PoolClient, workspaceId: string, excludedUserId: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM users
      WHERE workspace_id = $1
        AND role = 'workspace_admin'
        AND status = 'active'
        AND id <> $2
      FOR UPDATE
    `,
    [workspaceId, excludedUserId]
  );

  return result.rows.map((row) => row.id);
}

function enforceActiveAccess(user: UserRecord, workspace: WorkspaceRecord): void {
  if (workspace.status === "suspended") {
    throw new UserServiceError(403, "workspace_suspended", "Workspace is suspended");
  }

  if (workspace.status === "deleted") {
    throw new UserServiceError(403, "workspace_deleted", "Workspace is deleted");
  }

  if (user.status === "suspended") {
    throw new UserServiceError(403, "user_suspended", "User is suspended");
  }

  if (user.status === "deleted") {
    throw new UserServiceError(403, "user_deleted", "User is deleted");
  }
}

async function mintAccessToken(user: UserRecord, sessionId: string): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    email: user.email,
    workspace_id: user.workspaceId,
    role: user.role,
    sid: sessionId,
    fpc: user.forcePasswordChange
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("sps")
    .setAudience("sps-user")
    .setSubject(user.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(userJwtSecret());

  return { token, expiresAt };
}

async function mintRefreshToken(user: UserRecord, sessionId: string): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + REFRESH_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    workspace_id: user.workspaceId,
    sid: sessionId,
    typ: "refresh"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("sps")
    .setAudience("sps-user-refresh")
    .setSubject(user.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(userJwtSecret());

  return { token, expiresAt };
}

async function createSessionAndTokens(
  client: PoolClient,
  user: UserRecord,
  session: SessionContext
): Promise<AuthTokens> {
  const pendingTokenHash = `pending_${randomBytes(16).toString("hex")}`;
  const created = await client.query<{ id: string }>(
    `
      INSERT INTO user_sessions (user_id, workspace_id, refresh_token_hash, user_agent, ip_address, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      user.id,
      user.workspaceId,
      pendingTokenHash,
      normalizeUserAgent(session.userAgent),
      normalizeIpAddress(session.ipAddress),
      toDateFromEpoch(nowSeconds() + REFRESH_TOKEN_TTL_SECONDS)
    ]
  );

  const sessionId = created.rows[0].id;
  const [accessToken, refreshToken] = await Promise.all([
    mintAccessToken(user, sessionId),
    mintRefreshToken(user, sessionId)
  ]);

  await client.query(
    `
      UPDATE user_sessions
      SET refresh_token_hash = $2, expires_at = $3, last_used_at = now()
      WHERE id = $1
    `,
    [sessionId, hashToken(refreshToken.token), toDateFromEpoch(refreshToken.expiresAt)]
  );

  return {
    accessToken: accessToken.token,
    refreshToken: refreshToken.token,
    accessTokenExpiresAt: accessToken.expiresAt,
    refreshTokenExpiresAt: refreshToken.expiresAt
  };
}

function mapPgError(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "23505") {
      throw new UserServiceError(409, "conflict", "Record already exists");
    }
  }

  throw error;
}

export async function registerUser(
  db: Pool,
  email: string,
  password: string,
  workspaceSlug: string,
  displayName: string,
  session: SessionContext = {}
): Promise<AuthResult> {
  const normalizedEmail = normalizeEmail(email);
  validateEmail(normalizedEmail);
  const normalizedPassword = normalizePassword(password);
  const passwordHash = await bcrypt.hash(normalizedPassword, PASSWORD_HASH_ROUNDS);
  const verificationToken = generateVerificationToken();
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const workspace = await createWorkspace(client, workspaceSlug, displayName, null);
    const insertedUser = await client.query<UserRow>(
      `
        INSERT INTO users (email, password_hash, verification_token, workspace_id, role)
        VALUES ($1, $2, $3, $4, 'workspace_admin')
        RETURNING id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
      `,
      [normalizedEmail, passwordHash, verificationToken, workspace.id]
    );
    const user = toUserRecord(insertedUser.rows[0]);

    await client.query(
      `
        UPDATE workspaces
        SET owner_user_id = $2, updated_at = now()
        WHERE id = $1
      `,
      [workspace.id, user.id]
    );

    const tokens = await createSessionAndTokens(client, user, session);

    await client.query("COMMIT");

    const latestWorkspace = (await getWorkspace(client, workspace.id)) ?? {
      ...workspace,
      ownerUserId: user.id
    };

    logVerificationUrl(normalizedEmail, verificationToken);

    return {
      user,
      workspace: latestWorkspace,
      tokens
    };
  } catch (error) {
    await client.query("ROLLBACK");
    mapPgError(error);
  } finally {
    client.release();
  }
}

export async function authenticateUser(
  db: Pool,
  email: string,
  password: string,
  session: SessionContext = {}
): Promise<AuthResult> {
  const normalizedEmail = normalizeEmail(email);
  validateEmail(normalizedEmail);
  const client = await db.connect();

  try {
    const row = await queryUserWithWorkspaceByEmail(client, normalizedEmail);
    if (!row) {
      throw new UserServiceError(401, "invalid_credentials", "Invalid credentials");
    }

    const user = toUserRecord(row);
    const workspace = requireWorkspaceRecord(row);
    enforceActiveAccess(user, workspace);

    const validPassword = await bcrypt.compare(password, row.password_hash);
    if (!validPassword) {
      throw new UserServiceError(401, "invalid_credentials", "Invalid credentials");
    }

    await client.query("BEGIN");
    const tokens = await createSessionAndTokens(client, user, session);
    await client.query("COMMIT");

    return {
      user,
      workspace,
      tokens
    };
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function verifyRefreshToken(refreshToken: string): Promise<JWTPayload & { sub: string; workspace_id: string; sid: string; typ: string }> {
  try {
    const { payload } = await jwtVerify(refreshToken, userJwtSecret(), {
      issuer: "sps",
      audience: "sps-user-refresh"
    });

    if (typeof payload.sub !== "string" || typeof payload.workspace_id !== "string" || typeof payload.sid !== "string") {
      throw new UserServiceError(401, "invalid_refresh_token", "Invalid refresh token");
    }

    if (payload.typ !== "refresh") {
      throw new UserServiceError(401, "invalid_refresh_token", "Invalid refresh token");
    }

    return payload as JWTPayload & { sub: string; workspace_id: string; sid: string; typ: string };
  } catch (error) {
    if (error instanceof UserServiceError) {
      throw error;
    }

    throw new UserServiceError(401, "invalid_refresh_token", "Invalid refresh token");
  }
}

export async function refreshSession(
  db: Pool,
  refreshToken: string,
  session: SessionContext = {}
): Promise<AuthResult> {
  const payload = await verifyRefreshToken(refreshToken);
  const presentedTokenHash = hashToken(refreshToken);
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const current = await client.query<UserRow>(
      `
        SELECT
          u.id,
          u.email,
          u.password_hash,
          u.force_password_change,
          u.email_verified,
          u.verification_token,
          u.workspace_id,
          u.role,
          u.status,
          u.created_at,
          u.updated_at,
          w.slug AS workspace_slug,
          w.display_name AS workspace_display_name,
        w.tier AS workspace_tier,
        w.status AS workspace_status,
        w.owner_user_id AS workspace_owner_user_id,
        w.created_at AS workspace_created_at,
        w.updated_at AS workspace_updated_at
        FROM user_sessions s
        INNER JOIN users u ON u.id = s.user_id
        INNER JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id = $1
          AND s.user_id = $2
          AND s.workspace_id = $3
          AND s.refresh_token_hash = $4
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
        FOR UPDATE
      `,
      [payload.sid, payload.sub, payload.workspace_id, presentedTokenHash]
    );

    const row = current.rows[0];
    if (!row) {
      throw new UserServiceError(401, "invalid_refresh_token", "Invalid refresh token");
    }

    const user = toUserRecord(row);
    const workspace = requireWorkspaceRecord(row);
    enforceActiveAccess(user, workspace);

    const [accessToken, nextRefreshToken] = await Promise.all([
      mintAccessToken(user, payload.sid),
      mintRefreshToken(user, payload.sid)
    ]);

    await client.query(
      `
        UPDATE user_sessions
        SET refresh_token_hash = $2,
            last_used_at = now(),
            expires_at = $3,
            user_agent = COALESCE($4, user_agent),
            ip_address = COALESCE($5, ip_address)
        WHERE id = $1
      `,
      [
        payload.sid,
        hashToken(nextRefreshToken.token),
        toDateFromEpoch(nextRefreshToken.expiresAt),
        normalizeUserAgent(session.userAgent),
        normalizeIpAddress(session.ipAddress)
      ]
    );

    await client.query("COMMIT");

    return {
      user,
      workspace,
      tokens: {
        accessToken: accessToken.token,
        refreshToken: nextRefreshToken.token,
        accessTokenExpiresAt: accessToken.expiresAt,
        refreshTokenExpiresAt: nextRefreshToken.expiresAt
      }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function logoutSession(db: Pool, userId: string, workspaceId: string, sessionId: string): Promise<boolean> {
  const result = await db.query(
    `
      UPDATE user_sessions
      SET revoked_at = now()
      WHERE id = $1
        AND user_id = $2
        AND workspace_id = $3
        AND revoked_at IS NULL
    `,
    [sessionId, userId, workspaceId]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function changePassword(
  db: Pool,
  userId: string,
  workspaceId: string,
  currentPassword: string,
  nextPassword: string,
  sessionId: string
): Promise<{ user: UserRecord; accessToken: string; accessTokenExpiresAt: number }> {
  const normalizedNextPassword = normalizePassword(nextPassword);
  const client = await db.connect();

  try {
    await client.query("BEGIN");
    const row = await queryUserWithWorkspaceById(client, userId);
    if (!row || row.workspace_id !== workspaceId) {
      throw new UserServiceError(404, "user_not_found", "User not found");
    }

    const user = toUserRecord(row);
    const workspace = requireWorkspaceRecord(row);
    enforceActiveAccess(user, workspace);

    const validPassword = await bcrypt.compare(currentPassword, row.password_hash);
    if (!validPassword) {
      throw new UserServiceError(401, "invalid_credentials", "Invalid current password");
    }

    const passwordHash = await bcrypt.hash(normalizedNextPassword, PASSWORD_HASH_ROUNDS);
    const updated = await client.query<UserRow>(
      `
        UPDATE users
        SET password_hash = $2,
            force_password_change = false,
            updated_at = now()
        WHERE id = $1
        RETURNING id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
      `,
      [userId, passwordHash]
    );

    const updatedUser = toUserRecord(updated.rows[0]);
    const token = await mintAccessToken(updatedUser, sessionId);
    await client.query("COMMIT");

    return {
      user: updatedUser,
      accessToken: token.token,
      accessTokenExpiresAt: token.expiresAt
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyEmail(db: Pool, token: string): Promise<UserWithWorkspace> {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new UserServiceError(400, "invalid_verification_token", "Verification token is required");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<UserRow>(
      `
        UPDATE users
        SET email_verified = true,
            verification_token = NULL,
            updated_at = now()
        WHERE verification_token = $1
        RETURNING id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
      `,
      [normalizedToken]
    );

    const row = updated.rows[0];
    if (!row) {
      throw new UserServiceError(404, "verification_not_found", "Verification token not found");
    }

    const workspace = await getWorkspace(client, row.workspace_id);
    if (!workspace) {
      throw new UserServiceError(404, "workspace_not_found", "Workspace not found");
    }

    await client.query("COMMIT");

    return {
      user: toUserRecord(row),
      workspace
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserContext(db: Pool, userId: string): Promise<UserWithWorkspace | null> {
  const client = await db.connect();

  try {
    const row = await queryUserWithWorkspaceById(client, userId);
    if (!row) {
      return null;
    }

    return {
      user: toUserRecord(row),
      workspace: requireWorkspaceRecord(row)
    };
  } finally {
    client.release();
  }
}

export async function listWorkspaceUsers(db: Pool, workspaceId: string): Promise<UserRecord[]> {
  const result = await db.query<UserRow>(
    `
      SELECT id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
      FROM users
      WHERE workspace_id = $1
      ORDER BY created_at ASC
    `,
    [workspaceId]
  );

  return result.rows.map(toUserRecord);
}

export async function countActiveWorkspaceUsers(db: Pool, workspaceId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM users
      WHERE workspace_id = $1
        AND status = 'active'
    `,
    [workspaceId]
  );

  return Number(result.rows[0]?.count ?? "0");
}

export async function getWorkspaceOwnerVerificationState(
  db: Pool,
  workspaceId: string
): Promise<WorkspaceOwnerVerificationState | null> {
  const client = await db.connect();

  try {
    return await queryWorkspaceOwnerVerificationState(client, workspaceId);
  } finally {
    client.release();
  }
}

export async function ensureWorkspaceOwnerVerified(db: Pool, workspaceId: string): Promise<void> {
  const state = await getWorkspaceOwnerVerificationState(db, workspaceId);
  if (!state) {
    throw new UserServiceError(404, "workspace_not_found", "Workspace not found");
  }

  if (!state.ownerUserId) {
    throw new UserServiceError(409, "workspace_owner_missing", "Workspace owner is not configured");
  }

  if (!state.ownerEmailVerified) {
    throw new UserServiceError(
      403,
      "workspace_owner_unverified",
      "Workspace owner email must be verified before performing this action"
    );
  }
}

export async function createWorkspaceMember(
  db: Pool,
  workspaceId: string,
  input: CreateWorkspaceMemberInput
): Promise<UserRecord> {
  const normalizedEmail = normalizeEmail(input.email);
  validateEmail(normalizedEmail);
  if (!isUserRole(input.role)) {
    throw new UserServiceError(400, "invalid_role", "Invalid user role");
  }

  const normalizedPassword = normalizeTemporaryPassword(input.temporaryPassword);
  const passwordHash = await bcrypt.hash(normalizedPassword, PASSWORD_HASH_ROUNDS);
  const verificationToken = generateVerificationToken();

  try {
    const inserted = await db.query<UserRow>(
      `
        INSERT INTO users (email, password_hash, force_password_change, verification_token, workspace_id, role, status)
        VALUES ($1, $2, true, $3, $4, $5, 'active')
        RETURNING id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
      `,
      [normalizedEmail, passwordHash, verificationToken, workspaceId, input.role]
    );

    logVerificationUrl(normalizedEmail, verificationToken);
    return toUserRecord(inserted.rows[0]);
  } catch (error) {
    mapPgError(error);
  }
}

export async function updateWorkspaceMember(
  db: Pool,
  workspaceId: string,
  userId: string,
  updates: UpdateWorkspaceMemberInput
): Promise<UserRecord> {
  if (updates.role !== undefined && !isUserRole(updates.role)) {
    throw new UserServiceError(400, "invalid_role", "Invalid user role");
  }

  if (updates.status !== undefined && updates.status !== "active" && updates.status !== "suspended" && updates.status !== "deleted") {
    throw new UserServiceError(400, "invalid_status", "Invalid user status");
  }

  if (updates.role === undefined && updates.status === undefined) {
    throw new UserServiceError(400, "invalid_update", "At least one field must be provided");
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<UserRow>(
      `
        SELECT id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
        FROM users
        WHERE id = $1
          AND workspace_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [userId, workspaceId]
    );

    const row = current.rows[0];
    if (!row) {
      throw new UserServiceError(404, "user_not_found", "User not found");
    }

    const nextRole = updates.role ?? row.role;
    const nextStatus = updates.status ?? row.status;
    if (row.role === "workspace_admin" && row.status === "active" && (nextRole !== "workspace_admin" || nextStatus !== "active")) {
      const otherAdminIds = await listOtherActiveAdmins(client, workspaceId, row.id);
      if (otherAdminIds.length === 0) {
        throw new UserServiceError(
          409,
          "last_admin_lockout",
          "The last active workspace_admin cannot be demoted, suspended, or deleted"
        );
      }
    }

    const updated = await client.query<UserRow>(
      `
        UPDATE users
        SET role = $3,
            status = $4,
            updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
        RETURNING id, email, password_hash, force_password_change, email_verified, verification_token, workspace_id, role, status, created_at, updated_at
      `,
      [userId, workspaceId, nextRole, nextStatus]
    );

    await client.query("COMMIT");
    return toUserRecord(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
