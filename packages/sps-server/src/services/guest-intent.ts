import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { buildGuestIntentQuote, type X402Config, type X402Quote } from "./x402.js";
import { generateOpaqueToken, type PublicOfferRecord } from "./guest-offer.js";

export type GuestActorType = "guest_agent" | "guest_human";
export type GuestIntentStatus = "pending_approval" | "payment_required" | "activated" | "rejected" | "revoked" | "expired";
export type GuestApprovalStatus = "pending" | "approved" | "rejected";
export type GuestAgentDeliveryState = "dispatched" | "failed";

interface GuestIntentRow {
  id: string;
  workspace_id: string;
  offer_id: string;
  actor_type: GuestActorType;
  status: GuestIntentStatus;
  approval_status: GuestApprovalStatus | null;
  approval_reference: string | null;
  approval_decided_by_user_id: string | null;
  approval_decided_at: Date | null;
  requester_public_key: string;
  requester_public_key_hash: string;
  guest_subject_hash: string;
  requester_label: string | null;
  purpose: string;
  delivery_mode: PublicOfferRecord["deliveryMode"];
  payment_policy: PublicOfferRecord["paymentPolicy"];
  price_usd_cents: string | number;
  included_free_uses: number;
  resolved_secret_name: string;
  allowed_fulfiller_id: string | null;
  status_token: string;
  policy_snapshot_json: Record<string, unknown>;
  settled_policy_snapshot_json: Record<string, unknown> | null;
  payment_quote_json: X402Quote | null;
  request_id: string | null;
  exchange_id: string | null;
  agent_delivery_state: GuestAgentDeliveryState | null;
  agent_delivery_failure_reason: string | null;
  agent_delivery_failed_at: Date | null;
  agent_delivery_last_dispatched_at: Date | null;
  agent_delivery_attempt_count: number;
  activated_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface GuestIntentRecord {
  id: string;
  workspaceId: string;
  offerId: string;
  actorType: GuestActorType;
  status: GuestIntentStatus;
  approvalStatus: GuestApprovalStatus | null;
  approvalReference: string | null;
  approvalDecidedByUserId: string | null;
  approvalDecidedAt: Date | null;
  requesterPublicKey: string;
  requesterPublicKeyHash: string;
  guestSubjectHash: string;
  requesterLabel: string | null;
  purpose: string;
  deliveryMode: PublicOfferRecord["deliveryMode"];
  paymentPolicy: PublicOfferRecord["paymentPolicy"];
  priceUsdCents: number;
  includedFreeUses: number;
  resolvedSecretName: string;
  allowedFulfillerId: string | null;
  statusToken: string;
  policySnapshot: Record<string, unknown>;
  settledPolicySnapshot: Record<string, unknown> | null;
  paymentQuote: X402Quote | null;
  requestId: string | null;
  exchangeId: string | null;
  agentDeliveryState: GuestAgentDeliveryState | null;
  agentDeliveryFailureReason: string | null;
  agentDeliveryFailedAt: Date | null;
  agentDeliveryLastDispatchedAt: Date | null;
  agentDeliveryAttemptCount: number;
  activatedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGuestIntentInput {
  actorType: GuestActorType;
  requesterPublicKey: string;
  purpose: string;
  requesterLabel?: string;
  sourceIp: string;
}

interface GuestIntentAdminRow {
  id: string;
  workspace_id: string;
  offer_id: string;
  offer_label: string | null;
  offer_status: PublicOfferRecord["status"];
  offer_used_count: number;
  offer_max_uses: number | null;
  offer_expires_at: Date;
  actor_type: GuestActorType;
  status: GuestIntentStatus;
  approval_status: GuestApprovalStatus | null;
  approval_reference: string | null;
  requester_label: string | null;
  purpose: string;
  delivery_mode: PublicOfferRecord["deliveryMode"];
  payment_policy: PublicOfferRecord["paymentPolicy"];
  price_usd_cents: string | number;
  included_free_uses: number;
  resolved_secret_name: string;
  allowed_fulfiller_id: string | null;
  request_id: string | null;
  exchange_id: string | null;
  activated_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  latest_payment_id: string | null;
  latest_payment_status: "pending" | "verified" | "settled" | "failed" | null;
  latest_payment_tx_hash: string | null;
  latest_payment_settled_at: Date | null;
  latest_payment_created_at: Date | null;
  agent_delivery_state: GuestAgentDeliveryState | null;
  agent_delivery_failure_reason: string | null;
  agent_delivery_failed_at: Date | null;
  agent_delivery_last_dispatched_at: Date | null;
  agent_delivery_attempt_count: number;
}

export interface GuestIntentAdminRecord {
  id: string;
  workspaceId: string;
  offerId: string;
  offerLabel: string | null;
  offerStatus: PublicOfferRecord["status"];
  offerUsedCount: number;
  offerMaxUses: number | null;
  offerExpiresAt: Date;
  actorType: GuestActorType;
  status: GuestIntentStatus;
  effectiveStatus: Exclude<GuestIntentStatus, "expired"> | "expired";
  approvalStatus: GuestApprovalStatus | null;
  approvalReference: string | null;
  requesterLabel: string | null;
  purpose: string;
  deliveryMode: PublicOfferRecord["deliveryMode"];
  paymentPolicy: PublicOfferRecord["paymentPolicy"];
  priceUsdCents: number;
  includedFreeUses: number;
  resolvedSecretName: string;
  allowedFulfillerId: string | null;
  requestId: string | null;
  exchangeId: string | null;
  activatedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  latestPaymentId: string | null;
  latestPaymentStatus: "pending" | "verified" | "settled" | "failed" | null;
  latestPaymentTxHash: string | null;
  latestPaymentSettledAt: Date | null;
  latestPaymentCreatedAt: Date | null;
  agentDeliveryState: GuestAgentDeliveryState | null;
  agentDeliveryFailureReason: string | null;
  agentDeliveryFailedAt: Date | null;
  agentDeliveryLastDispatchedAt: Date | null;
  agentDeliveryAttemptCount: number;
}

export type CreateGuestIntentResult =
  | { kind: "pending_approval"; intent: GuestIntentRecord; httpStatus: 202 }
  | { kind: "rejected"; intent: GuestIntentRecord; httpStatus: 403 }
  | { kind: "payment_required"; intent: GuestIntentRecord; quote: X402Quote; httpStatus: 402 }
  | { kind: "activated"; intent: GuestIntentRecord; httpStatus: 201 };

export class GuestIntentServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function toNumber(value: string | number): number {
  return Number(value);
}

function defaultAgentDeliveryState(row: Pick<GuestIntentRow, "delivery_mode" | "status" | "exchange_id" | "agent_delivery_state">): GuestAgentDeliveryState | null {
  if (row.agent_delivery_state) {
    return row.agent_delivery_state;
  }

  if (row.delivery_mode === "agent" && row.status === "activated" && row.exchange_id) {
    return "dispatched";
  }

  return null;
}

function toGuestIntentRecord(row: GuestIntentRow): GuestIntentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    offerId: row.offer_id,
    actorType: row.actor_type,
    status: row.status,
    approvalStatus: row.approval_status,
    approvalReference: row.approval_reference,
    approvalDecidedByUserId: row.approval_decided_by_user_id,
    approvalDecidedAt: row.approval_decided_at,
    requesterPublicKey: row.requester_public_key,
    requesterPublicKeyHash: row.requester_public_key_hash,
    guestSubjectHash: row.guest_subject_hash,
    requesterLabel: row.requester_label,
    purpose: row.purpose,
    deliveryMode: row.delivery_mode,
    paymentPolicy: row.payment_policy,
    priceUsdCents: toNumber(row.price_usd_cents),
    includedFreeUses: toNumber(row.included_free_uses),
    resolvedSecretName: row.resolved_secret_name,
    allowedFulfillerId: row.allowed_fulfiller_id,
    statusToken: row.status_token,
    policySnapshot: row.policy_snapshot_json,
    settledPolicySnapshot: row.settled_policy_snapshot_json,
    paymentQuote: row.payment_quote_json,
    requestId: row.request_id,
    exchangeId: row.exchange_id,
    agentDeliveryState: defaultAgentDeliveryState(row),
    agentDeliveryFailureReason: row.agent_delivery_failure_reason,
    agentDeliveryFailedAt: row.agent_delivery_failed_at,
    agentDeliveryLastDispatchedAt: row.agent_delivery_last_dispatched_at,
    agentDeliveryAttemptCount: toNumber(row.agent_delivery_attempt_count),
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function effectiveGuestIntentStatus(status: GuestIntentStatus, revokedAt: Date | null, expiresAt: Date): Exclude<GuestIntentStatus, "expired"> | "expired" {
  if (revokedAt) {
    return "revoked";
  }

  if (expiresAt.getTime() <= Date.now()) {
    return "expired";
  }

  return status;
}

function toGuestIntentAdminRecord(row: GuestIntentAdminRow): GuestIntentAdminRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    offerId: row.offer_id,
    offerLabel: row.offer_label,
    offerStatus: row.offer_status,
    offerUsedCount: toNumber(row.offer_used_count),
    offerMaxUses: row.offer_max_uses === null ? null : toNumber(row.offer_max_uses),
    offerExpiresAt: row.offer_expires_at,
    actorType: row.actor_type,
    status: row.status,
    effectiveStatus: effectiveGuestIntentStatus(row.status, row.revoked_at, row.expires_at),
    approvalStatus: row.approval_status,
    approvalReference: row.approval_reference,
    requesterLabel: row.requester_label,
    purpose: row.purpose,
    deliveryMode: row.delivery_mode,
    paymentPolicy: row.payment_policy,
    priceUsdCents: toNumber(row.price_usd_cents),
    includedFreeUses: toNumber(row.included_free_uses),
    resolvedSecretName: row.resolved_secret_name,
    allowedFulfillerId: row.allowed_fulfiller_id,
    requestId: row.request_id,
    exchangeId: row.exchange_id,
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestPaymentId: row.latest_payment_id,
    latestPaymentStatus: row.latest_payment_status,
    latestPaymentTxHash: row.latest_payment_tx_hash,
    latestPaymentSettledAt: row.latest_payment_settled_at,
    latestPaymentCreatedAt: row.latest_payment_created_at,
    agentDeliveryState: row.agent_delivery_state ?? (
      row.delivery_mode === "agent" && row.status === "activated" && row.exchange_id ? "dispatched" : null
    ),
    agentDeliveryFailureReason: row.agent_delivery_failure_reason,
    agentDeliveryFailedAt: row.agent_delivery_failed_at,
    agentDeliveryLastDispatchedAt: row.agent_delivery_last_dispatched_at,
    agentDeliveryAttemptCount: toNumber(row.agent_delivery_attempt_count)
  };
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildGuestSubjectHash(sourceIp: string, requesterPublicKey: string, actorType: GuestActorType): string {
  return hashValue(`${sourceIp}:${actorType}:${requesterPublicKey}`);
}

function buildPolicySnapshot(offer: PublicOfferRecord, input: CreateGuestIntentInput): Record<string, unknown> {
  return {
    offer_id: offer.id,
    workspace_id: offer.workspaceId,
    delivery_mode: offer.deliveryMode,
    payment_policy: offer.paymentPolicy,
    price_usd_cents: offer.priceUsdCents,
    included_free_uses: offer.includedFreeUses,
    secret_name: offer.secretName,
    secret_alias: offer.secretAlias,
    requester_label: input.requesterLabel?.trim() || null,
    requester_public_key_hash: hashValue(input.requesterPublicKey),
    purpose: input.purpose.trim(),
    allowed_fulfiller_id: offer.allowedFulfillerId,
    require_approval: offer.requireApproval
  };
}

async function withTx<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function selectIntentById(client: PoolClient, intentId: string): Promise<GuestIntentRecord | null> {
  const result = await client.query<GuestIntentRow>(
    `
      SELECT *
      FROM guest_intents
      WHERE id = $1
      LIMIT 1
    `,
    [intentId]
  );
  return result.rows[0] ? toGuestIntentRecord(result.rows[0]) : null;
}

async function selectIntentByStatusToken(db: Pool, intentId: string, statusToken: string): Promise<GuestIntentRecord | null> {
  const result = await db.query<GuestIntentRow>(
    `
      SELECT *
      FROM guest_intents
      WHERE id = $1
        AND status_token = $2
      LIMIT 1
    `,
    [intentId, statusToken]
  );
  return result.rows[0] ? toGuestIntentRecord(result.rows[0]) : null;
}

export async function getGuestIntentById(db: Pool, intentId: string): Promise<GuestIntentRecord | null> {
  const result = await db.query<GuestIntentRow>(
    `
      SELECT *
      FROM guest_intents
      WHERE id = $1
      LIMIT 1
    `,
    [intentId]
  );

  return result.rows[0] ? toGuestIntentRecord(result.rows[0]) : null;
}

export async function listGuestIntentsForWorkspace(
  db: Pool,
  workspaceId: string,
  filters: {
    offerId?: string;
    status?: GuestIntentStatus | "expired";
    approvalStatus?: GuestApprovalStatus;
    limit?: number;
  } = {}
): Promise<GuestIntentAdminRecord[]> {
  const values: Array<string | number> = [workspaceId];
  const clauses = ["gi.workspace_id = $1"];

  if (filters.offerId) {
    values.push(filters.offerId);
    clauses.push(`gi.offer_id = $${values.length}`);
  }

  if (filters.approvalStatus) {
    values.push(filters.approvalStatus);
    clauses.push(`gi.approval_status = $${values.length}`);
  }

  if (filters.status && filters.status !== "expired") {
    values.push(filters.status);
    clauses.push(`gi.status = $${values.length}`);
  }

  if (filters.status === "expired") {
    clauses.push("gi.revoked_at IS NULL");
    clauses.push("gi.expires_at <= now()");
  }

  const limit = Math.min(200, Math.max(1, Math.floor(filters.limit ?? 100)));
  values.push(limit);

  const result = await db.query<GuestIntentAdminRow>(
    `
      SELECT
        gi.id,
        gi.workspace_id,
        gi.offer_id,
        po.offer_label,
        po.status AS offer_status,
        po.used_count AS offer_used_count,
        po.max_uses AS offer_max_uses,
        po.expires_at AS offer_expires_at,
        gi.actor_type,
        gi.status,
        gi.approval_status,
        gi.approval_reference,
        gi.requester_label,
        gi.purpose,
        gi.delivery_mode,
        gi.payment_policy,
        gi.price_usd_cents,
        gi.included_free_uses,
        gi.resolved_secret_name,
        gi.allowed_fulfiller_id,
        gi.request_id,
        gi.exchange_id,
        gi.agent_delivery_state,
        gi.agent_delivery_failure_reason,
        gi.agent_delivery_failed_at,
        gi.agent_delivery_last_dispatched_at,
        gi.agent_delivery_attempt_count,
        gi.activated_at,
        gi.revoked_at,
        gi.expires_at,
        gi.created_at,
        gi.updated_at,
        gp.payment_id AS latest_payment_id,
        gp.status AS latest_payment_status,
        gp.tx_hash AS latest_payment_tx_hash,
        gp.settled_at AS latest_payment_settled_at,
        gp.created_at AS latest_payment_created_at
      FROM guest_intents gi
      INNER JOIN public_offers po
        ON po.id = gi.offer_id
      LEFT JOIN LATERAL (
        SELECT
          payment_id,
          status,
          tx_hash,
          settled_at,
          created_at
        FROM guest_payments
        WHERE workspace_id = gi.workspace_id
          AND intent_id = gi.id
        ORDER BY created_at DESC
        LIMIT 1
      ) gp
        ON TRUE
      WHERE ${clauses.join("\n        AND ")}
      ORDER BY gi.created_at DESC
      LIMIT $${values.length}
    `,
    values
  );

  return result.rows.map(toGuestIntentAdminRecord);
}

export async function getGuestIntentAdminById(
  db: Pool,
  workspaceId: string,
  intentId: string
): Promise<GuestIntentAdminRecord | null> {
  const result = await db.query<GuestIntentAdminRow>(
    `
      SELECT
        gi.id,
        gi.workspace_id,
        gi.offer_id,
        po.offer_label,
        po.status AS offer_status,
        po.used_count AS offer_used_count,
        po.max_uses AS offer_max_uses,
        po.expires_at AS offer_expires_at,
        gi.actor_type,
        gi.status,
        gi.approval_status,
        gi.approval_reference,
        gi.requester_label,
        gi.purpose,
        gi.delivery_mode,
        gi.payment_policy,
        gi.price_usd_cents,
        gi.included_free_uses,
        gi.resolved_secret_name,
        gi.allowed_fulfiller_id,
        gi.request_id,
        gi.exchange_id,
        gi.agent_delivery_state,
        gi.agent_delivery_failure_reason,
        gi.agent_delivery_failed_at,
        gi.agent_delivery_last_dispatched_at,
        gi.agent_delivery_attempt_count,
        gi.activated_at,
        gi.revoked_at,
        gi.expires_at,
        gi.created_at,
        gi.updated_at,
        gp.payment_id AS latest_payment_id,
        gp.status AS latest_payment_status,
        gp.tx_hash AS latest_payment_tx_hash,
        gp.settled_at AS latest_payment_settled_at,
        gp.created_at AS latest_payment_created_at
      FROM guest_intents gi
      INNER JOIN public_offers po
        ON po.id = gi.offer_id
      LEFT JOIN LATERAL (
        SELECT
          payment_id,
          status,
          tx_hash,
          settled_at,
          created_at
        FROM guest_payments
        WHERE workspace_id = gi.workspace_id
          AND intent_id = gi.id
        ORDER BY created_at DESC
        LIMIT 1
      ) gp
        ON TRUE
      WHERE gi.workspace_id = $1
        AND gi.id = $2
      LIMIT 1
    `,
    [workspaceId, intentId]
  );

  return result.rows[0] ? toGuestIntentAdminRecord(result.rows[0]) : null;
}

async function activateFreeIntent(
  client: PoolClient,
  offer: PublicOfferRecord,
  row: GuestIntentRow
): Promise<GuestIntentRecord> {
  await client.query(
    `
      UPDATE public_offers
      SET used_count = used_count + 1,
          updated_at = now()
      WHERE id = $1
    `,
    [offer.id]
  );

  const updated = await client.query<GuestIntentRow>(
    `
      UPDATE guest_intents
      SET status = 'activated',
          approval_status = CASE
            WHEN approval_status = 'approved' THEN 'approved'
            ELSE approval_status
          END,
          payment_quote_json = NULL,
          activated_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [row.id]
  );

  return toGuestIntentRecord(updated.rows[0]);
}

async function setIntentPaymentRequired(
  client: PoolClient,
  offer: PublicOfferRecord,
  row: GuestIntentRow,
  x402Config: X402Config
): Promise<{ intent: GuestIntentRecord; quote: X402Quote }> {
  if (!x402Config.enabled) {
    throw new GuestIntentServiceError(403, "x402_disabled", "Guest x402 overages are disabled");
  }

  const quote = buildGuestIntentQuote(x402Config, {
    workspaceId: offer.workspaceId,
    intentId: row.id,
    secretName: row.resolved_secret_name,
    amountUsdCents: offer.priceUsdCents
  });

  const updated = await client.query<GuestIntentRow>(
    `
      UPDATE guest_intents
      SET status = 'payment_required',
          payment_quote_json = $2::jsonb,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [row.id, JSON.stringify(quote)]
  );

  return {
    intent: toGuestIntentRecord(updated.rows[0]),
    quote
  };
}

function offerExpired(offer: PublicOfferRecord): boolean {
  return offer.expiresAt.getTime() <= Date.now();
}

function offerRevoked(offer: PublicOfferRecord): boolean {
  return offer.status === "revoked" || offer.revokedAt !== null;
}

async function createPendingApprovalIntent(
  client: PoolClient,
  offer: PublicOfferRecord,
  input: CreateGuestIntentInput,
  guestSubjectHash: string
): Promise<GuestIntentRecord> {
  const approvalReference = generateOpaqueToken("gapr");
  const statusToken = generateOpaqueToken("gstat");
  const result = await client.query<GuestIntentRow>(
    `
      INSERT INTO guest_intents (
        workspace_id,
        offer_id,
        actor_type,
        status,
        approval_status,
        approval_reference,
        requester_public_key,
        requester_public_key_hash,
        guest_subject_hash,
        requester_label,
        purpose,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        resolved_secret_name,
        allowed_fulfiller_id,
        status_token,
        policy_snapshot_json,
        expires_at
      )
      VALUES (
        $1, $2, $3, 'pending_approval', 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18
      )
      RETURNING *
    `,
    [
      offer.workspaceId,
      offer.id,
      input.actorType,
      approvalReference,
      input.requesterPublicKey,
      hashValue(input.requesterPublicKey),
      guestSubjectHash,
      input.requesterLabel?.trim() || null,
      input.purpose.trim(),
      offer.deliveryMode,
      offer.paymentPolicy,
      offer.priceUsdCents,
      offer.includedFreeUses,
      offer.secretName,
      offer.allowedFulfillerId,
      statusToken,
      JSON.stringify(buildPolicySnapshot(offer, input)),
      offer.expiresAt
    ]
  );

  return toGuestIntentRecord(result.rows[0]);
}

async function createImmediateIntent(
  client: PoolClient,
  offer: PublicOfferRecord,
  input: CreateGuestIntentInput,
  guestSubjectHash: string
): Promise<GuestIntentRow> {
  const statusToken = generateOpaqueToken("gstat");
  const result = await client.query<GuestIntentRow>(
    `
      INSERT INTO guest_intents (
        workspace_id,
        offer_id,
        actor_type,
        status,
        requester_public_key,
        requester_public_key_hash,
        guest_subject_hash,
        requester_label,
        purpose,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        resolved_secret_name,
        allowed_fulfiller_id,
        status_token,
        policy_snapshot_json,
        expires_at
      )
      VALUES (
        $1, $2, $3, 'payment_required', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17
      )
      RETURNING *
    `,
    [
      offer.workspaceId,
      offer.id,
      input.actorType,
      input.requesterPublicKey,
      hashValue(input.requesterPublicKey),
      guestSubjectHash,
      input.requesterLabel?.trim() || null,
      input.purpose.trim(),
      offer.deliveryMode,
      offer.paymentPolicy,
      offer.priceUsdCents,
      offer.includedFreeUses,
      offer.secretName,
      offer.allowedFulfillerId,
      statusToken,
      JSON.stringify(buildPolicySnapshot(offer, input)),
      offer.expiresAt
    ]
  );

  return result.rows[0];
}

export async function createOrResumeGuestIntent(
  db: Pool,
  offerToken: string,
  offer: PublicOfferRecord,
  input: CreateGuestIntentInput,
  x402Config: X402Config
): Promise<CreateGuestIntentResult> {
  if (offerRevoked(offer) || offerExpired(offer)) {
    throw new GuestIntentServiceError(410, "offer_not_available", "Offer is no longer available");
  }

  if (!offer.secretName) {
    throw new GuestIntentServiceError(400, "unsupported_offer", "secret_alias offers are not implemented yet");
  }

  void offerToken;

  return withTx(db, async (client) => {
    const lockedOfferResult = await client.query<{
      id: string;
      used_count: number;
      max_uses: number | null;
      expires_at: Date;
      status: PublicOfferRecord["status"];
      revoked_at: Date | null;
    }>(
      `
        SELECT id, used_count, max_uses, expires_at, status, revoked_at
        FROM public_offers
        WHERE id = $1
        FOR UPDATE
      `,
      [offer.id]
    );
    const lockedOffer = lockedOfferResult.rows[0];
    if (!lockedOffer) {
      throw new GuestIntentServiceError(404, "offer_not_found", "Offer was not found");
    }
    if (lockedOffer.status === "revoked" || lockedOffer.revoked_at !== null || lockedOffer.expires_at.getTime() <= Date.now()) {
      throw new GuestIntentServiceError(410, "offer_not_available", "Offer is no longer available");
    }
    if (lockedOffer.max_uses !== null && lockedOffer.used_count >= lockedOffer.max_uses) {
      throw new GuestIntentServiceError(410, "offer_exhausted", "Offer has no remaining capacity");
    }

    const guestSubjectHash = buildGuestSubjectHash(input.sourceIp, input.requesterPublicKey, input.actorType);
    const existingResult = await client.query<GuestIntentRow>(
      `
        SELECT *
        FROM guest_intents
        WHERE offer_id = $1
          AND guest_subject_hash = $2
          AND expires_at > now()
          AND status IN ('pending_approval', 'payment_required', 'rejected')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [offer.id, guestSubjectHash]
    );
    const existing = existingResult.rows[0];

    if (existing) {
      if (existing.status === "payment_required" && existing.payment_quote_json) {
        return {
          kind: "payment_required",
          intent: toGuestIntentRecord(existing),
          quote: existing.payment_quote_json,
          httpStatus: 402
        };
      }

      if (existing.approval_status === "pending" || (existing.status === "pending_approval" && !existing.approval_status)) {
        return {
          kind: "pending_approval",
          intent: toGuestIntentRecord(existing),
          httpStatus: 202
        };
      }

      if (existing.approval_status === "rejected") {
        const rejected = await client.query<GuestIntentRow>(
          `
            UPDATE guest_intents
            SET status = 'rejected',
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `,
          [existing.id]
        );
        return {
          kind: "rejected",
          intent: toGuestIntentRecord(rejected.rows[0]),
          httpStatus: 403
        };
      }

      if (existing.approval_status === "approved") {
        if (offer.paymentPolicy === "free") {
          const activated = await activateFreeIntent(client, offer, existing);
          return { kind: "activated", intent: activated, httpStatus: 201 };
        }

        if (offer.paymentPolicy === "quota_then_x402" && lockedOffer.used_count < offer.includedFreeUses) {
          const activated = await activateFreeIntent(client, offer, existing);
          return { kind: "activated", intent: activated, httpStatus: 201 };
        }

        const paymentRequired = await setIntentPaymentRequired(client, offer, existing, x402Config);
        return {
          kind: "payment_required",
          intent: paymentRequired.intent,
          quote: paymentRequired.quote,
          httpStatus: 402
        };
      }
    }

    if (offer.requireApproval) {
      const pending = await createPendingApprovalIntent(client, offer, input, guestSubjectHash);
      return {
        kind: "pending_approval",
        intent: pending,
        httpStatus: 202
      };
    }

    const created = await createImmediateIntent(client, offer, input, guestSubjectHash);
    if (offer.paymentPolicy === "free") {
      const activated = await activateFreeIntent(client, offer, created);
      return { kind: "activated", intent: activated, httpStatus: 201 };
    }

    if (offer.paymentPolicy === "quota_then_x402" && lockedOffer.used_count < offer.includedFreeUses) {
      const activated = await activateFreeIntent(client, offer, created);
      return { kind: "activated", intent: activated, httpStatus: 201 };
    }

    const paymentRequired = await setIntentPaymentRequired(client, offer, created, x402Config);
    return {
      kind: "payment_required",
      intent: paymentRequired.intent,
      quote: paymentRequired.quote,
      httpStatus: 402
    };
  });
}

export async function getGuestIntentByStatusToken(
  db: Pool,
  intentId: string,
  statusToken: string
): Promise<GuestIntentRecord | null> {
  return selectIntentByStatusToken(db, intentId, statusToken);
}

export async function activateGuestIntent(
  db: Pool,
  input: {
    intentId: string;
    requestId?: string;
    exchangeId?: string;
    settledPolicySnapshot: Record<string, unknown>;
  }
): Promise<GuestIntentRecord> {
  const result = await db.query<GuestIntentRow>(
    `
      UPDATE guest_intents
      SET status = 'activated',
          request_id = COALESCE($2, request_id),
          exchange_id = COALESCE($3, exchange_id),
          agent_delivery_state = CASE
            WHEN COALESCE($3, exchange_id) IS NOT NULL THEN 'dispatched'
            ELSE agent_delivery_state
          END,
          agent_delivery_failure_reason = CASE
            WHEN COALESCE($3, exchange_id) IS NOT NULL THEN NULL
            ELSE agent_delivery_failure_reason
          END,
          agent_delivery_failed_at = CASE
            WHEN COALESCE($3, exchange_id) IS NOT NULL THEN NULL
            ELSE agent_delivery_failed_at
          END,
          agent_delivery_last_dispatched_at = CASE
            WHEN COALESCE($3, exchange_id) IS NOT NULL THEN now()
            ELSE agent_delivery_last_dispatched_at
          END,
          agent_delivery_attempt_count = CASE
            WHEN COALESCE($3, exchange_id) IS NOT NULL THEN GREATEST(agent_delivery_attempt_count, 1)
            ELSE agent_delivery_attempt_count
          END,
          settled_policy_snapshot_json = $4::jsonb,
          activated_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [
      input.intentId,
      input.requestId ?? null,
      input.exchangeId ?? null,
      JSON.stringify(input.settledPolicySnapshot)
    ]
  );

  if (!result.rows[0]) {
    throw new GuestIntentServiceError(404, "guest_intent_not_found", "Guest intent was not found");
  }

  return toGuestIntentRecord(result.rows[0]);
}

export async function decideGuestIntentApproval(
  db: Pool,
  workspaceId: string,
  intentId: string,
  decidedByUserId: string,
  nextStatus: "approved" | "rejected"
): Promise<GuestIntentRecord> {
  return withTx(db, async (client) => {
    const current = await selectIntentById(client, intentId);
    if (!current || current.workspaceId !== workspaceId) {
      throw new GuestIntentServiceError(404, "guest_intent_not_found", "Guest intent was not found");
    }
    if (current.status !== "pending_approval") {
      throw new GuestIntentServiceError(409, "guest_intent_not_pending", "Guest intent is no longer awaiting approval");
    }
    if (current.approvalStatus === "approved" || current.approvalStatus === "rejected") {
      throw new GuestIntentServiceError(409, "guest_intent_already_decided", "Guest intent approval has already been decided");
    }

    const updated = await client.query<GuestIntentRow>(
      `
        UPDATE guest_intents
        SET approval_status = $2,
            approval_decided_by_user_id = $3,
            approval_decided_at = now(),
            status = CASE
              WHEN $2 = 'rejected' THEN 'rejected'
              ELSE status
            END,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [intentId, nextStatus, decidedByUserId]
    );

    return toGuestIntentRecord(updated.rows[0]);
  });
}

export async function revokeGuestIntent(
  db: Pool,
  workspaceId: string,
  intentId: string
): Promise<GuestIntentRecord> {
  const result = await db.query<GuestIntentRow>(
    `
      UPDATE guest_intents
      SET status = 'revoked',
          revoked_at = now(),
          updated_at = now()
      WHERE workspace_id = $1
        AND id = $2
        AND status <> 'revoked'
      RETURNING *
    `,
    [workspaceId, intentId]
  );

  if (!result.rows[0]) {
    throw new GuestIntentServiceError(404, "guest_intent_not_found", "Guest intent was not found");
  }

  return toGuestIntentRecord(result.rows[0]);
}

export async function markGuestAgentDeliveryFailed(
  db: Pool,
  workspaceId: string,
  intentId: string,
  failureReason: string
): Promise<GuestIntentRecord> {
  return withTx(db, async (client) => {
    const current = await selectIntentById(client, intentId);
    if (!current || current.workspaceId !== workspaceId) {
      throw new GuestIntentServiceError(404, "guest_intent_not_found", "Guest intent was not found");
    }
    if (current.deliveryMode !== "agent" || !current.exchangeId) {
      throw new GuestIntentServiceError(409, "guest_intent_not_agent_delivery", "Guest intent is not using agent delivery");
    }
    if (current.status !== "activated" || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
      throw new GuestIntentServiceError(409, "guest_intent_not_recoverable", "Guest intent is no longer recoverable");
    }

    const updated = await client.query<GuestIntentRow>(
      `
        UPDATE guest_intents
        SET agent_delivery_state = 'failed',
            agent_delivery_failure_reason = $3,
            agent_delivery_failed_at = now(),
            updated_at = now()
        WHERE workspace_id = $1
          AND id = $2
        RETURNING *
      `,
      [workspaceId, intentId, failureReason.trim()]
    );

    return toGuestIntentRecord(updated.rows[0]);
  });
}

export async function retryGuestAgentDelivery(
  db: Pool,
  workspaceId: string,
  intentId: string
): Promise<GuestIntentRecord> {
  return withTx(db, async (client) => {
    const current = await selectIntentById(client, intentId);
    if (!current || current.workspaceId !== workspaceId) {
      throw new GuestIntentServiceError(404, "guest_intent_not_found", "Guest intent was not found");
    }
    if (current.deliveryMode !== "agent" || !current.exchangeId) {
      throw new GuestIntentServiceError(409, "guest_intent_not_agent_delivery", "Guest intent is not using agent delivery");
    }
    if (current.status !== "activated" || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
      throw new GuestIntentServiceError(409, "guest_intent_not_recoverable", "Guest intent is no longer recoverable");
    }
    if (current.agentDeliveryState !== "failed") {
      throw new GuestIntentServiceError(409, "guest_intent_delivery_not_failed", "Guest intent delivery is not awaiting retry");
    }

    const updated = await client.query<GuestIntentRow>(
      `
        UPDATE guest_intents
        SET agent_delivery_state = 'dispatched',
            agent_delivery_failure_reason = NULL,
            agent_delivery_failed_at = NULL,
            agent_delivery_last_dispatched_at = now(),
            agent_delivery_attempt_count = agent_delivery_attempt_count + 1,
            updated_at = now()
        WHERE workspace_id = $1
          AND id = $2
        RETURNING *
      `,
      [workspaceId, intentId]
    );

    return toGuestIntentRecord(updated.rows[0]);
  });
}

export async function cleanupExpiredUnpaidGuestIntents(
  db: Pool,
  workspaceId?: string
): Promise<{ expiredIntentCount: number }> {
  const values: Array<string> = [];
  const clauses = [
    "status IN ('pending_approval', 'payment_required')",
    "expires_at <= now()"
  ];

  if (workspaceId) {
    values.push(workspaceId);
    clauses.push(`workspace_id = $${values.length}`);
  }

  const result = await db.query<{ id: string }>(
    `
      UPDATE guest_intents
      SET status = 'expired',
          payment_quote_json = NULL,
          updated_at = now()
      WHERE ${clauses.join("\n        AND ")}
      RETURNING id
    `,
    values
  );

  return {
    expiredIntentCount: result.rowCount ?? result.rows.length
  };
}

export function toGuestIntentPublicStatus(intent: GuestIntentRecord): {
  intent_id: string;
  status: GuestIntentStatus | "expired";
  approval_status: GuestApprovalStatus | null;
  payment_required: boolean;
  expires_at: string;
} {
  const expired = intent.expiresAt.getTime() <= Date.now();
  return {
    intent_id: intent.id,
    status: expired ? "expired" : intent.status,
    approval_status: expired ? null : intent.approvalStatus,
    payment_required: !expired && intent.status === "payment_required",
    expires_at: intent.expiresAt.toISOString()
  };
}
