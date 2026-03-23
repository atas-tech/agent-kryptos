import { createHash, randomBytes } from "node:crypto";
import type { DbExecutor } from "../db/index.js";

export type PublicOfferDeliveryMode = "human" | "agent" | "either";
export type PublicOfferPaymentPolicy = "free" | "always_x402" | "quota_then_x402";
export type PublicOfferStatus = "active" | "revoked";

interface PublicOfferRow {
  id: string;
  workspace_id: string;
  created_by_user_id: string;
  offer_label: string | null;
  delivery_mode: PublicOfferDeliveryMode;
  payment_policy: PublicOfferPaymentPolicy;
  price_usd_cents: string | number;
  included_free_uses: number;
  secret_name: string | null;
  secret_alias: string | null;
  allowed_fulfiller_id: string | null;
  require_approval: boolean;
  token_hash: string;
  status: PublicOfferStatus;
  max_uses: number | null;
  used_count: number;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicOfferRecord {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  offerLabel: string | null;
  deliveryMode: PublicOfferDeliveryMode;
  paymentPolicy: PublicOfferPaymentPolicy;
  priceUsdCents: number;
  includedFreeUses: number;
  secretName: string | null;
  secretAlias: string | null;
  allowedFulfillerId: string | null;
  requireApproval: boolean;
  tokenHash: string;
  status: PublicOfferStatus;
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePublicOfferInput {
  offerLabel?: string;
  deliveryMode: PublicOfferDeliveryMode;
  paymentPolicy: PublicOfferPaymentPolicy;
  priceUsdCents: number;
  includedFreeUses?: number;
  secretName?: string;
  secretAlias?: string;
  allowedFulfillerId?: string;
  requireApproval?: boolean;
  maxUses?: number;
  expiresAt: Date;
}

export class GuestOfferServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function toNumber(value: string | number | null | undefined): number {
  return Number(value ?? 0);
}

function toPublicOfferRecord(row: PublicOfferRow): PublicOfferRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdByUserId: row.created_by_user_id,
    offerLabel: row.offer_label,
    deliveryMode: row.delivery_mode,
    paymentPolicy: row.payment_policy,
    priceUsdCents: toNumber(row.price_usd_cents),
    includedFreeUses: toNumber(row.included_free_uses),
    secretName: row.secret_name,
    secretAlias: row.secret_alias,
    allowedFulfillerId: row.allowed_fulfiller_id,
    requireApproval: row.require_approval,
    tokenHash: row.token_hash,
    status: row.status,
    maxUses: row.max_uses === null ? null : toNumber(row.max_uses),
    usedCount: toNumber(row.used_count),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createPublicOffer(
  db: DbExecutor,
  workspaceId: string,
  createdByUserId: string,
  input: CreatePublicOfferInput
): Promise<{ offer: PublicOfferRecord; offerToken: string }> {
  const offerToken = generateOpaqueToken("po");
  const tokenHash = hashOpaqueToken(offerToken);
  const result = await db.query<PublicOfferRow>(
    `
      INSERT INTO public_offers (
        workspace_id,
        created_by_user_id,
        offer_label,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        secret_name,
        secret_alias,
        allowed_fulfiller_id,
        require_approval,
        token_hash,
        max_uses,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING
        id,
        workspace_id,
        created_by_user_id,
        offer_label,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        secret_name,
        secret_alias,
        allowed_fulfiller_id,
        require_approval,
        token_hash,
        status,
        max_uses,
        used_count,
        expires_at,
        revoked_at,
        created_at,
        updated_at
    `,
    [
      workspaceId,
      createdByUserId,
      input.offerLabel?.trim() || null,
      input.deliveryMode,
      input.paymentPolicy,
      input.priceUsdCents,
      input.includedFreeUses ?? 0,
      input.secretName?.trim() || null,
      input.secretAlias?.trim() || null,
      input.allowedFulfillerId?.trim() || null,
      input.requireApproval === true,
      tokenHash,
      input.maxUses ?? null,
      input.expiresAt
    ]
  );

  return {
    offer: toPublicOfferRecord(result.rows[0]),
    offerToken
  };
}

export async function listPublicOffers(db: DbExecutor, workspaceId: string): Promise<PublicOfferRecord[]> {
  const result = await db.query<PublicOfferRow>(
    `
      SELECT
        id,
        workspace_id,
        created_by_user_id,
        offer_label,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        secret_name,
        secret_alias,
        allowed_fulfiller_id,
        require_approval,
        token_hash,
        status,
        max_uses,
        used_count,
        expires_at,
        revoked_at,
        created_at,
        updated_at
      FROM public_offers
      WHERE workspace_id = $1
      ORDER BY created_at DESC
    `,
    [workspaceId]
  );

  return result.rows.map(toPublicOfferRecord);
}

export async function getPublicOfferById(
  db: DbExecutor,
  workspaceId: string,
  offerId: string
): Promise<PublicOfferRecord | null> {
  const result = await db.query<PublicOfferRow>(
    `
      SELECT
        id,
        workspace_id,
        created_by_user_id,
        offer_label,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        secret_name,
        secret_alias,
        allowed_fulfiller_id,
        require_approval,
        token_hash,
        status,
        max_uses,
        used_count,
        expires_at,
        revoked_at,
        created_at,
        updated_at
      FROM public_offers
      WHERE workspace_id = $1
        AND id = $2
      LIMIT 1
    `,
    [workspaceId, offerId]
  );

  return result.rows[0] ? toPublicOfferRecord(result.rows[0]) : null;
}

export async function getPublicOfferByToken(
  db: DbExecutor,
  offerToken: string
): Promise<PublicOfferRecord | null> {
  const result = await db.query<PublicOfferRow>(
    `
      SELECT
        id,
        workspace_id,
        created_by_user_id,
        offer_label,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        secret_name,
        secret_alias,
        allowed_fulfiller_id,
        require_approval,
        token_hash,
        status,
        max_uses,
        used_count,
        expires_at,
        revoked_at,
        created_at,
        updated_at
      FROM public_offers
      WHERE token_hash = $1
      LIMIT 1
    `,
    [hashOpaqueToken(offerToken)]
  );

  return result.rows[0] ? toPublicOfferRecord(result.rows[0]) : null;
}

export async function revokePublicOffer(
  db: DbExecutor,
  workspaceId: string,
  offerId: string
): Promise<PublicOfferRecord | null> {
  const result = await db.query<PublicOfferRow>(
    `
      UPDATE public_offers
      SET status = 'revoked',
          revoked_at = now(),
          updated_at = now()
      WHERE workspace_id = $1
        AND id = $2
        AND status <> 'revoked'
      RETURNING
        id,
        workspace_id,
        created_by_user_id,
        offer_label,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        included_free_uses,
        secret_name,
        secret_alias,
        allowed_fulfiller_id,
        require_approval,
        token_hash,
        status,
        max_uses,
        used_count,
        expires_at,
        revoked_at,
        created_at,
        updated_at
    `,
    [workspaceId, offerId]
  );

  return result.rows[0] ? toPublicOfferRecord(result.rows[0]) : null;
}
