import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { buildGuestIntentQuote, type X402Config, type X402Quote } from "./x402.js";
import { generateOpaqueToken, type PublicOfferRecord } from "./guest-offer.js";

export type GuestActorType = "guest_agent" | "guest_human";
export type GuestIntentStatus = "pending_approval" | "payment_required" | "activated" | "rejected" | "revoked" | "expired";
export type GuestApprovalStatus = "pending" | "approved" | "rejected";

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
    activatedAt: row.activated_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
