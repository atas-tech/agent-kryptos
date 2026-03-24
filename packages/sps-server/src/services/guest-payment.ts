import type { Pool } from "pg";
import type { X402Provider, X402Quote } from "./x402.js";
import {
  buildPaymentRequiredPayload,
  parsePaymentSignatureHeader,
  type X402Config,
  validateQuotedPayment,
  X402ServiceError
} from "./x402.js";

interface GuestPaymentRow {
  id: string;
  workspace_id: string;
  intent_id: string;
  payment_id: string;
  request_hash: string;
  quoted_amount_cents: string | number;
  quoted_currency: string;
  quoted_asset_symbol: string;
  quoted_asset_amount: string;
  scheme: string;
  network_id: string;
  tx_hash: string | null;
  facilitator_url: string | null;
  payer_address: string | null;
  quote_expires_at: Date | null;
  status: "pending" | "verified" | "settled" | "failed";
  response_cache: Record<string, unknown> | null;
  response_cache_expires_at: Date | null;
  settled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GuestPaymentRecord {
  id: string;
  workspaceId: string;
  intentId: string;
  paymentId: string;
  requestHash: string;
  quotedAmountCents: number;
  quotedCurrency: string;
  quotedAssetSymbol: string;
  quotedAssetAmount: string;
  scheme: string;
  networkId: string;
  txHash: string | null;
  facilitatorUrl: string | null;
  payerAddress: string | null;
  quoteExpiresAt: Date | null;
  status: "pending" | "verified" | "settled" | "failed";
  responseCache: Record<string, unknown> | null;
  responseCacheExpiresAt: Date | null;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toNumber(value: string | number): number {
  return Number(value);
}

function toGuestPaymentRecord(row: GuestPaymentRow): GuestPaymentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    intentId: row.intent_id,
    paymentId: row.payment_id,
    requestHash: row.request_hash,
    quotedAmountCents: toNumber(row.quoted_amount_cents),
    quotedCurrency: row.quoted_currency,
    quotedAssetSymbol: row.quoted_asset_symbol,
    quotedAssetAmount: row.quoted_asset_amount,
    scheme: row.scheme,
    networkId: row.network_id,
    txHash: row.tx_hash,
    facilitatorUrl: row.facilitator_url,
    payerAddress: row.payer_address,
    quoteExpiresAt: row.quote_expires_at,
    status: row.status,
    responseCache: row.response_cache,
    responseCacheExpiresAt: row.response_cache_expires_at,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function findGuestPaymentByPaymentId(
  db: Pool,
  workspaceId: string,
  paymentId: string
): Promise<GuestPaymentRecord | null> {
  const result = await db.query<GuestPaymentRow>(
    `
      SELECT *
      FROM guest_payments
      WHERE workspace_id = $1
        AND payment_id = $2
      LIMIT 1
    `,
    [workspaceId, paymentId]
  );

  return result.rows[0] ? toGuestPaymentRecord(result.rows[0]) : null;
}

export async function insertPendingGuestPayment(
  db: Pool,
  input: {
    workspaceId: string;
    intentId: string;
    paymentId: string;
    requestHash: string;
    quote: X402Quote;
    facilitatorUrl: string | null;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO guest_payments (
        workspace_id,
        intent_id,
        payment_id,
        request_hash,
        quoted_amount_cents,
        quoted_currency,
        quoted_asset_symbol,
        quoted_asset_amount,
        scheme,
        network_id,
        facilitator_url,
        quote_expires_at,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'USD', 'USDC', $6, 'exact', $7, $8, to_timestamp($9), 'pending')
      ON CONFLICT (workspace_id, payment_id)
      DO NOTHING
    `,
    [
      input.workspaceId,
      input.intentId,
      input.paymentId,
      input.requestHash,
      input.quote.amountUsdCents,
      input.quote.amountAssetDisplay,
      input.quote.networkId,
      input.facilitatorUrl,
      input.quote.quoteExpiresAt
    ]
  );
}

export async function markGuestPaymentVerified(
  db: Pool,
  workspaceId: string,
  paymentId: string,
  payerAddress?: string | null
): Promise<void> {
  await db.query(
    `
      UPDATE guest_payments
      SET status = 'verified',
          payer_address = COALESCE($3, payer_address),
          updated_at = now()
      WHERE workspace_id = $1
        AND payment_id = $2
        AND status = 'pending'
    `,
    [workspaceId, paymentId, payerAddress ?? null]
  );
}

export async function markGuestPaymentFailed(
  db: Pool,
  workspaceId: string,
  paymentId: string
): Promise<void> {
  await db.query(
    `
      UPDATE guest_payments
      SET status = 'failed',
          updated_at = now()
      WHERE workspace_id = $1
        AND payment_id = $2
        AND status <> 'settled'
    `,
    [workspaceId, paymentId]
  );
}

export async function markGuestPaymentSettled(
  db: Pool,
  input: {
    workspaceId: string;
    paymentId: string;
    txHash: string;
    responseCache: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE guest_payments
      SET status = 'settled',
          tx_hash = $3,
          settled_at = now(),
          response_cache = $4::jsonb,
          response_cache_expires_at = now() + interval '30 days',
          updated_at = now()
      WHERE workspace_id = $1
        AND payment_id = $2
    `,
    [input.workspaceId, input.paymentId, input.txHash, JSON.stringify(input.responseCache)]
  );
}

export async function verifyAndSettleGuestPayment(
  db: Pool,
  provider: X402Provider,
  config: X402Config,
  input: {
    workspaceId: string;
    intentId: string;
    requestHash: string;
    paymentId: string;
    paymentSignature: string;
    quote: X402Quote;
  }
): Promise<{ txHash: string; cachedResponse?: Record<string, unknown> }> {
  const existing = await findGuestPaymentByPaymentId(db, input.workspaceId, input.paymentId);
  if (existing) {
    if (existing.requestHash !== input.requestHash) {
      throw new X402ServiceError(409, "payment_identifier_conflict", "payment-identifier reuse does not match the original request");
    }
    if (existing.status === "settled" && existing.responseCache) {
      return {
        txHash: existing.txHash ?? "",
        cachedResponse: existing.responseCache
      };
    }
    throw new X402ServiceError(409, "payment_in_progress", "Payment is already being processed for this request");
  }

  if (input.quote.quoteExpiresAt <= Math.floor(Date.now() / 1000)) {
    throw new X402ServiceError(402, "quote_expired", "Payment quote has expired");
  }

  await insertPendingGuestPayment(db, {
    workspaceId: input.workspaceId,
    intentId: input.intentId,
    paymentId: input.paymentId,
    requestHash: input.requestHash,
    quote: input.quote,
    facilitatorUrl: config.facilitatorUrl
  });

  try {
    let paymentPayload: ReturnType<typeof parsePaymentSignatureHeader>;
    try {
      paymentPayload = parsePaymentSignatureHeader(input.paymentSignature);
    } catch {
      throw new X402ServiceError(400, "invalid_payment_signature", "Invalid PAYMENT-SIGNATURE header");
    }

    const paymentDetails = buildPaymentRequiredPayload(input.quote);
    validateQuotedPayment(paymentDetails, paymentPayload, config.networkId);

    const verifyResult = await provider.verifyPayment({
      paymentPayload,
      paymentDetails,
      paymentId: input.paymentId
    });
    if (!verifyResult.valid) {
      await markGuestPaymentFailed(db, input.workspaceId, input.paymentId);
      throw new X402ServiceError(402, "payment_verification_failed", "Payment verification failed");
    }

    await markGuestPaymentVerified(db, input.workspaceId, input.paymentId, verifyResult.payer ?? null);

    const settlement = await provider.settlePayment({
      paymentPayload,
      paymentDetails,
      paymentId: input.paymentId
    });

    return {
      txHash: settlement.txHash
    };
  } catch (error) {
    const normalizedError = error instanceof X402ServiceError
      ? error
      : new X402ServiceError(502, "x402_provider_error", "Payment facilitator request failed");
    await markGuestPaymentFailed(db, input.workspaceId, input.paymentId).catch(() => undefined);
    throw normalizedError;
  }
}
