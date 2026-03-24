import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { decodePageCursor, encodePageCursor } from "./pagination.js";

const DEFAULT_PRICE_USD_CENTS = 5;
const DEFAULT_FREE_EXCHANGE_MONTHLY_CAP = 10;
const DEFAULT_NETWORK_ID = "eip155:84532";
const DEFAULT_QUOTE_TTL_SECONDS = 300;
const DEFAULT_LEASE_DURATION_SECONDS = 60;
const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;
const RESPONSE_CACHE_RETENTION_DAYS = 30;
const USDC_DECIMALS = 6;
const X402_ASSET_BY_NETWORK: Record<string, {
  address: string;
  name: string;
  version: string;
}> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2"
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2"
  }
};

export interface X402Config {
  enabled: boolean;
  facilitatorUrl: string | null;
  payToAddress: string;
  priceUsdCents: number;
  freeExchangeMonthlyCap: number;
  networkId: string;
  quoteTtlSeconds: number;
  leaseDurationSeconds: number;
  providerTimeoutMs: number;
}

export interface X402PaymentOption {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    resource: string;
    description: string;
    name: string;
    version: string;
    quoted_amount_cents: number;
    quoted_currency: "USD";
    quoted_asset_symbol: "USDC";
    quoted_asset_amount: string;
    quote_expires_at: number;
  };
}

export interface X402PaymentRequired {
  accepts: [X402PaymentOption];
  x402Version: 2;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  extensions?: Record<string, unknown>;
  metadata: {
    quoted_amount_cents: number;
    quoted_currency: "USD";
    quoted_asset_symbol: "USDC";
    quoted_asset_amount: string;
    quote_expires_at: number;
  };
}

export interface X402Quote {
  amountUsdCents: number;
  amountAssetUnits: string;
  amountAssetDisplay: string;
  networkId: string;
  resource: string;
  description: string;
  payTo: string;
  quoteExpiresAt: number;
}

export interface X402PaymentSignaturePayload {
  x402Version: 2;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepted: X402PaymentOption;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface X402VerifyInput {
  paymentPayload: X402PaymentSignaturePayload;
  paymentDetails: X402PaymentRequired;
  paymentId: string;
}

export interface X402VerifyResult {
  valid: boolean;
  payer?: string | null;
  failureReason?: string | null;
}

export interface X402SettleInput {
  paymentPayload: X402PaymentSignaturePayload;
  paymentDetails: X402PaymentRequired;
  paymentId: string;
}

export interface X402SettleResult {
  status: "settled";
  txHash: string;
}

export interface X402Provider {
  readonly name: string;
  verifyPayment(input: X402VerifyInput): Promise<X402VerifyResult>;
  settlePayment(input: X402SettleInput): Promise<X402SettleResult>;
}

export interface X402TransactionRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  paymentId: string;
  requestHash: string;
  quotedAmountCents: number;
  quotedCurrency: string;
  quotedAssetSymbol: string;
  quotedAssetAmount: string;
  scheme: string;
  networkId: string;
  resourceType: string;
  resourceId: string | null;
  txHash: string | null;
  facilitatorUrl: string | null;
  quoteExpiresAt: Date | null;
  status: "pending" | "verified" | "settled" | "failed";
  settledAt: Date | null;
  responseCache: Record<string, unknown> | null;
  responseCacheExpiresAt: Date | null;
  createdAt: Date;
}

export interface AgentAllowanceRecord {
  agentId: string;
  displayName: string | null;
  status: string | null;
  monthlyBudgetCents: number;
  currentSpendCents: number;
  remainingBudgetCents: number;
  budgetResetAt: Date;
  updatedAt: Date;
}

export interface X402TransactionPage {
  transactions: X402TransactionRecord[];
  nextCursor: string | null;
}

interface AgentAllowanceRow {
  agent_id: string;
  display_name: string | null;
  status: string | null;
  monthly_budget_cents: string | number;
  current_spend_cents: string | number;
  budget_reset_at: Date;
  updated_at: Date;
}

interface X402TransactionRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  payment_id: string;
  request_hash: string;
  quoted_amount_cents: string | number;
  quoted_currency: string;
  quoted_asset_symbol: string;
  quoted_asset_amount: string;
  scheme: string;
  network_id: string;
  resource_type: string;
  resource_id: string | null;
  tx_hash: string | null;
  facilitator_url: string | null;
  quote_expires_at: Date | null;
  status: "pending" | "verified" | "settled" | "failed";
  settled_at: Date | null;
  response_cache: Record<string, unknown> | null;
  response_cache_expires_at: Date | null;
  created_at: Date;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function x402ConfigFromEnv(): X402Config {
  const enabledRaw = process.env.SPS_X402_ENABLED?.trim().toLowerCase();
  const enabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes";
  const payToAddress = process.env.SPS_X402_PAY_TO_ADDRESS?.trim()
    || (process.env.NODE_ENV === "test" ? "0x0000000000000000000000000000000000000001" : "");

  return {
    enabled,
    facilitatorUrl: process.env.SPS_X402_FACILITATOR_URL?.trim() || null,
    payToAddress,
    priceUsdCents: readPositiveInteger(process.env.SPS_X402_PRICE_USD_CENTS, DEFAULT_PRICE_USD_CENTS),
    freeExchangeMonthlyCap: readPositiveInteger(process.env.SPS_X402_FREE_EXCHANGE_MONTHLY_CAP, DEFAULT_FREE_EXCHANGE_MONTHLY_CAP),
    networkId: process.env.SPS_X402_NETWORK_ID?.trim() || DEFAULT_NETWORK_ID,
    quoteTtlSeconds: readPositiveInteger(process.env.SPS_X402_QUOTE_TTL_SECONDS, DEFAULT_QUOTE_TTL_SECONDS),
    leaseDurationSeconds: readPositiveInteger(process.env.SPS_X402_LEASE_DURATION_SECONDS, DEFAULT_LEASE_DURATION_SECONDS),
    providerTimeoutMs: readPositiveInteger(process.env.SPS_X402_PROVIDER_TIMEOUT_MS, DEFAULT_PROVIDER_TIMEOUT_MS)
  };
}

function toMinorUnitsFromCents(cents: number): string {
  return String(cents * 10 ** (USDC_DECIMALS - 2));
}

function toDisplayAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function toResourceUrl(resource: string): string {
  return `sps://${resource.replace(/^\/+/, "")}`;
}

function getX402AssetInfo(networkId: string): {
  address: string;
  name: string;
  version: string;
} {
  return X402_ASSET_BY_NETWORK[networkId] ?? {
    address: "USDC",
    name: "USDC",
    version: "2"
  };
}

function utcMonthStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function nextUtcMonthStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function cacheExpiry(date = new Date()): Date {
  return new Date(date.getTime() + RESPONSE_CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function hashX402Request(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function buildExchangeQuote(config: X402Config, params: {
  workspaceId: string;
  agentId: string;
  secretName: string;
}): X402Quote {
  const quoteExpiresAt = Math.floor(Date.now() / 1000) + config.quoteTtlSeconds;
  return {
    amountUsdCents: config.priceUsdCents,
    amountAssetUnits: toMinorUnitsFromCents(config.priceUsdCents),
    amountAssetDisplay: toDisplayAmount(config.priceUsdCents),
    networkId: config.networkId,
    resource: `secret_exchange:${params.workspaceId}:${params.agentId}:${params.secretName}`,
    description: "Secret exchange request overage",
    payTo: config.payToAddress,
    quoteExpiresAt
  };
}

export function buildGuestIntentQuote(config: X402Config, params: {
  workspaceId: string;
  intentId: string;
  secretName: string;
  amountUsdCents: number;
}): X402Quote {
  const quoteExpiresAt = Math.floor(Date.now() / 1000) + config.quoteTtlSeconds;
  return {
    amountUsdCents: params.amountUsdCents,
    amountAssetUnits: toMinorUnitsFromCents(params.amountUsdCents),
    amountAssetDisplay: toDisplayAmount(params.amountUsdCents),
    networkId: config.networkId,
    resource: `guest_secret_intent:${params.workspaceId}:${params.intentId}:${params.secretName}`,
    description: "Guest secret request activation",
    payTo: config.payToAddress,
    quoteExpiresAt
  };
}

export function buildPaymentRequiredPayload(quote: X402Quote): X402PaymentRequired {
  const timeoutSeconds = Math.max(1, quote.quoteExpiresAt - Math.floor(Date.now() / 1000));
  const asset = getX402AssetInfo(quote.networkId);
  return {
    accepts: [{
      scheme: "exact",
      network: quote.networkId,
      asset: asset.address,
      amount: quote.amountAssetUnits,
      payTo: quote.payTo,
      maxTimeoutSeconds: timeoutSeconds,
      extra: {
        resource: quote.resource,
        description: quote.description,
        name: asset.name,
        version: asset.version,
        quoted_amount_cents: quote.amountUsdCents,
        quoted_currency: "USD",
        quoted_asset_symbol: "USDC",
        quoted_asset_amount: quote.amountAssetDisplay,
        quote_expires_at: quote.quoteExpiresAt
      }
    }],
    x402Version: 2,
    resource: {
      url: toResourceUrl(quote.resource),
      description: quote.description
    },
    metadata: {
      quoted_amount_cents: quote.amountUsdCents,
      quoted_currency: "USD",
      quoted_asset_symbol: "USDC",
      quoted_asset_amount: quote.amountAssetDisplay,
      quote_expires_at: quote.quoteExpiresAt
    }
  };
}

export function encodePaymentRequiredHeader(payload: X402PaymentRequired): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function encodePaymentResponseHeader(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function parsePaymentSignatureHeader(value: string): X402PaymentSignaturePayload {
  const trimmed = value.trim();
  const candidates = [
    trimmed,
    Buffer.from(trimmed, "base64").toString("utf8"),
    Buffer.from(trimmed, "base64url").toString("utf8")
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<X402PaymentSignaturePayload>;
      if (
        parsed.x402Version === 2 &&
        parsed.accepted &&
        typeof parsed.accepted === "object" &&
        typeof parsed.accepted.scheme === "string" &&
        typeof parsed.accepted.network === "string" &&
        typeof parsed.accepted.asset === "string" &&
        typeof parsed.accepted.amount === "string" &&
        typeof parsed.accepted.payTo === "string" &&
        typeof parsed.accepted.maxTimeoutSeconds === "number" &&
        parsed.accepted.extra &&
        typeof parsed.accepted.extra === "object" &&
        typeof parsed.payload === "object" &&
        parsed.payload !== null
      ) {
        return {
          x402Version: 2,
          resource: parsed.resource && typeof parsed.resource === "object" && typeof parsed.resource.url === "string"
            ? {
                url: parsed.resource.url.trim(),
                description: typeof parsed.resource.description === "string" ? parsed.resource.description.trim() : undefined,
                mimeType: typeof parsed.resource.mimeType === "string" ? parsed.resource.mimeType.trim() : undefined
              }
            : undefined,
          accepted: {
            scheme: "exact",
            network: parsed.accepted.network.trim(),
            asset: parsed.accepted.asset.trim(),
            amount: parsed.accepted.amount.trim(),
            payTo: parsed.accepted.payTo.trim(),
            maxTimeoutSeconds: parsed.accepted.maxTimeoutSeconds,
            extra: {
              resource: String((parsed.accepted.extra as Record<string, unknown>).resource ?? "").trim(),
              description: String((parsed.accepted.extra as Record<string, unknown>).description ?? "").trim(),
              name: String((parsed.accepted.extra as Record<string, unknown>).name ?? "USDC").trim(),
              version: String((parsed.accepted.extra as Record<string, unknown>).version ?? "2").trim(),
              quoted_amount_cents: Number((parsed.accepted.extra as Record<string, unknown>).quoted_amount_cents ?? Number.NaN),
              quoted_currency: "USD",
              quoted_asset_symbol: "USDC",
              quoted_asset_amount: String((parsed.accepted.extra as Record<string, unknown>).quoted_asset_amount ?? "").trim(),
              quote_expires_at: Number((parsed.accepted.extra as Record<string, unknown>).quote_expires_at ?? Number.NaN)
            }
          },
          payload: parsed.payload as Record<string, unknown>,
          extensions: parsed.extensions && typeof parsed.extensions === "object"
            ? parsed.extensions
            : undefined
        };
      }

      const legacy = parsed as Partial<{
        x402Version: number;
        paymentId: string;
        scheme: string;
        network: string;
        amount: string;
        resource: string;
        payer: string;
        signature: string;
      }>;
      if (
        legacy.x402Version === 2 &&
        typeof legacy.paymentId === "string" &&
        typeof legacy.scheme === "string" &&
        typeof legacy.network === "string" &&
        typeof legacy.amount === "string" &&
        typeof legacy.resource === "string"
      ) {
        return {
          x402Version: 2,
          resource: {
            url: toResourceUrl(legacy.resource.trim())
          },
          accepted: {
            scheme: "exact",
            network: legacy.network.trim(),
            asset: "USDC",
            amount: legacy.amount.trim(),
            payTo: "",
            maxTimeoutSeconds: 0,
            extra: {
              resource: legacy.resource.trim(),
              description: "",
              name: "USDC",
              version: "2",
              quoted_amount_cents: Number.NaN,
              quoted_currency: "USD",
              quoted_asset_symbol: "USDC",
              quoted_asset_amount: "",
              quote_expires_at: 0
            }
          },
          payload: {
            paymentId: legacy.paymentId.trim(),
            payer: typeof legacy.payer === "string" ? legacy.payer.trim() : undefined,
            signature: typeof legacy.signature === "string" ? legacy.signature.trim() : undefined
          }
        };
      }
    } catch {
      // Try next candidate.
    }
  }

  throw new Error("Invalid PAYMENT-SIGNATURE header");
}

export class HttpX402Provider implements X402Provider {
  readonly name = "http";

  constructor(private readonly facilitatorUrl: string, private readonly timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS) {}

  async verifyPayment(input: X402VerifyInput): Promise<X402VerifyResult> {
    const response = await this.post<{
      isValid: boolean;
      invalidReason?: string;
      payer?: string | null;
    }>("/verify", {
      x402Version: 2,
      paymentPayload: input.paymentPayload,
      paymentRequirements: input.paymentPayload.accepted
    });

    return {
      valid: response.isValid,
      payer: response.payer ?? null,
      failureReason: response.invalidReason ?? null
    };
  }

  async settlePayment(input: X402SettleInput): Promise<X402SettleResult> {
    const response = await this.post<{
      success: boolean;
      transaction: string;
      errorReason?: string;
      errorMessage?: string;
    }>("/settle", {
      x402Version: 2,
      paymentPayload: input.paymentPayload,
      paymentRequirements: input.paymentPayload.accepted
    });

    if (!response.success) {
      throw new Error(response.errorMessage ?? response.errorReason ?? "Facilitator settlement failed");
    }

    return {
      status: "settled",
      txHash: response.transaction
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.facilitatorUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Facilitator request failed with status ${response.status}`);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class X402ServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function validateQuotedPayment(
  paymentRequired: X402PaymentRequired,
  paymentPayload: X402PaymentSignaturePayload,
  expectedNetworkId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): void {
  if (paymentRequired.metadata.quote_expires_at <= nowSeconds) {
    throw new X402ServiceError(402, "quote_expired", "Payment quote has expired");
  }

  const accepted = paymentPayload.accepted;
  const expected = paymentRequired.accepts[0];

  if (accepted.scheme !== "exact") {
    throw new X402ServiceError(400, "unsupported_payment_scheme", "Unsupported x402 payment scheme");
  }

  if (accepted.network !== expectedNetworkId || expected.network !== expectedNetworkId) {
    throw new X402ServiceError(400, "unsupported_payment_network", "Unsupported x402 payment network");
  }

  if (
    accepted.network !== expected.network
    || accepted.asset !== expected.asset
    || accepted.amount !== expected.amount
    || accepted.scheme !== expected.scheme
    || accepted.payTo.toLowerCase() !== expected.payTo.toLowerCase()
    || String(accepted.extra.resource ?? "") !== String(expected.extra.resource ?? "")
  ) {
    throw new X402ServiceError(400, "payment_requirements_mismatch", "PAYMENT-SIGNATURE does not match the quoted payment requirements");
  }
}

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function toAgentAllowanceRecord(row: AgentAllowanceRow): AgentAllowanceRecord {
  const monthlyBudgetCents = toNumber(row.monthly_budget_cents);
  const currentSpendCents = toNumber(row.current_spend_cents);

  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    status: row.status,
    monthlyBudgetCents,
    currentSpendCents,
    remainingBudgetCents: Math.max(0, monthlyBudgetCents - currentSpendCents),
    budgetResetAt: row.budget_reset_at,
    updatedAt: row.updated_at
  };
}

function toTransactionRecord(row: X402TransactionRow): X402TransactionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    paymentId: row.payment_id,
    requestHash: row.request_hash,
    quotedAmountCents: toNumber(row.quoted_amount_cents),
    quotedCurrency: row.quoted_currency,
    quotedAssetSymbol: row.quoted_asset_symbol,
    quotedAssetAmount: row.quoted_asset_amount,
    scheme: row.scheme,
    networkId: row.network_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    txHash: row.tx_hash,
    facilitatorUrl: row.facilitator_url,
    quoteExpiresAt: row.quote_expires_at,
    status: row.status,
    settledAt: row.settled_at,
    responseCache: row.response_cache,
    responseCacheExpiresAt: row.response_cache_expires_at,
    createdAt: row.created_at
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
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeFreeExchangeSlot(
  db: Pool,
  workspaceId: string,
  cap: number,
  now = new Date()
): Promise<{ granted: boolean; used: number; cap: number; usageMonth: Date }> {
  return withTx(db, async (client) => {
    const usageMonth = utcMonthStart(now);
    const existing = await client.query<{ free_exchange_used: number }>(
      `
        SELECT free_exchange_used
        FROM workspace_exchange_usage
        WHERE workspace_id = $1
          AND usage_month = $2
        FOR UPDATE
      `,
      [workspaceId, usageMonth]
    );

    const row = existing.rows[0];
    if (!row) {
      await client.query(
        `
          INSERT INTO workspace_exchange_usage (workspace_id, usage_month, free_exchange_used, updated_at)
          VALUES ($1, $2, 1, now())
        `,
        [workspaceId, usageMonth]
      );

      return { granted: true, used: 1, cap, usageMonth };
    }

    const used = Number(row.free_exchange_used);
    if (used >= cap) {
      return { granted: false, used, cap, usageMonth };
    }

    const nextUsed = used + 1;
    await client.query(
      `
        UPDATE workspace_exchange_usage
        SET free_exchange_used = $3,
            updated_at = now()
        WHERE workspace_id = $1
          AND usage_month = $2
      `,
      [workspaceId, usageMonth, nextUsed]
    );

    return { granted: true, used: nextUsed, cap, usageMonth };
  });
}

export async function setAgentAllowance(
  db: Pool,
  workspaceId: string,
  agentId: string,
  monthlyBudgetCents: number,
  now = new Date()
): Promise<AgentAllowanceRecord> {
  return withTx(db, async (client) => {
    const existing = await client.query<{ current_spend_cents: string | number; budget_reset_at: Date }>(
      `
        SELECT current_spend_cents, budget_reset_at
        FROM agent_allowances
        WHERE workspace_id = $1
          AND agent_id = $2
        FOR UPDATE
      `,
      [workspaceId, agentId]
    );

    const stale = existing.rows[0]?.budget_reset_at && existing.rows[0]!.budget_reset_at.getTime() <= now.getTime();
    const currentSpendCents = stale ? 0 : toNumber(existing.rows[0]?.current_spend_cents ?? 0);
    const budgetResetAt = stale ? nextUtcMonthStart(now) : existing.rows[0]?.budget_reset_at ?? nextUtcMonthStart(now);

    const result = await client.query<AgentAllowanceRow>(
      `
        INSERT INTO agent_allowances (
          workspace_id,
          agent_id,
          monthly_budget_cents,
          current_spend_cents,
          budget_reset_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (workspace_id, agent_id)
        DO UPDATE SET
          monthly_budget_cents = EXCLUDED.monthly_budget_cents,
          current_spend_cents = EXCLUDED.current_spend_cents,
          budget_reset_at = EXCLUDED.budget_reset_at,
          updated_at = now()
        RETURNING agent_id, NULL::text AS display_name, NULL::text AS status, monthly_budget_cents, current_spend_cents, budget_reset_at, updated_at
      `,
      [workspaceId, agentId, monthlyBudgetCents, currentSpendCents, budgetResetAt]
    );

    return toAgentAllowanceRecord(result.rows[0]);
  });
}

export async function listAgentAllowances(db: Pool, workspaceId: string): Promise<AgentAllowanceRecord[]> {
  await db.query(
    `
      UPDATE agent_allowances
      SET current_spend_cents = 0,
          budget_reset_at = date_trunc('month', now() AT TIME ZONE 'UTC') + INTERVAL '1 month',
          updated_at = now()
      WHERE workspace_id = $1
        AND budget_reset_at <= now()
    `,
    [workspaceId]
  );

  const result = await db.query<AgentAllowanceRow>(
    `
      SELECT
        aa.agent_id,
        ea.display_name,
        ea.status,
        aa.monthly_budget_cents,
        aa.current_spend_cents,
        aa.budget_reset_at,
        aa.updated_at
      FROM agent_allowances aa
      LEFT JOIN enrolled_agents ea
        ON ea.workspace_id = aa.workspace_id
       AND ea.agent_id = aa.agent_id
      WHERE aa.workspace_id = $1
      ORDER BY aa.agent_id ASC
    `,
    [workspaceId]
  );

  return result.rows.map(toAgentAllowanceRecord);
}

export async function reserveAllowanceSpend(
  db: Pool,
  workspaceId: string,
  agentId: string,
  amountCents: number,
  now = new Date()
): Promise<AgentAllowanceRecord> {
  return withTx(db, async (client) => {
    const result = await client.query<AgentAllowanceRow>(
      `
        SELECT
          aa.agent_id,
          NULL::text AS display_name,
          NULL::text AS status,
          aa.monthly_budget_cents,
          aa.current_spend_cents,
          aa.budget_reset_at,
          aa.updated_at
        FROM agent_allowances aa
        WHERE aa.workspace_id = $1
          AND aa.agent_id = $2
        FOR UPDATE
      `,
      [workspaceId, agentId]
    );

    const row = result.rows[0];
    if (!row) {
      throw new X402ServiceError(403, "x402_budget_denied", "No x402 allowance is configured for this agent");
    }

    let currentSpendCents = toNumber(row.current_spend_cents);
    let budgetResetAt = row.budget_reset_at;
    const monthlyBudgetCents = toNumber(row.monthly_budget_cents);

    if (budgetResetAt.getTime() <= now.getTime()) {
      currentSpendCents = 0;
      budgetResetAt = nextUtcMonthStart(now);
      await client.query(
        `
          UPDATE agent_allowances
          SET current_spend_cents = 0,
              budget_reset_at = $3,
              updated_at = now()
          WHERE workspace_id = $1
            AND agent_id = $2
        `,
        [workspaceId, agentId, budgetResetAt]
      );
    }

    if (currentSpendCents + amountCents > monthlyBudgetCents) {
      throw new X402ServiceError(403, "x402_budget_denied", "Agent allowance exceeded");
    }

    const nextSpendCents = currentSpendCents + amountCents;
    const updated = await client.query<AgentAllowanceRow>(
      `
        UPDATE agent_allowances
        SET current_spend_cents = $3,
            updated_at = now()
        WHERE workspace_id = $1
          AND agent_id = $2
        RETURNING agent_id, NULL::text AS display_name, NULL::text AS status, monthly_budget_cents, current_spend_cents, budget_reset_at, updated_at
      `,
      [workspaceId, agentId, nextSpendCents]
    );

    return toAgentAllowanceRecord(updated.rows[0]);
  });
}

export async function rollbackAllowanceSpend(
  db: Pool,
  workspaceId: string,
  agentId: string,
  amountCents: number
): Promise<void> {
  await db.query(
    `
      UPDATE agent_allowances
      SET current_spend_cents = GREATEST(0, current_spend_cents - $3),
          updated_at = now()
      WHERE workspace_id = $1
        AND agent_id = $2
    `,
    [workspaceId, agentId, amountCents]
  );
}

export async function acquireInflightLease(
  db: Pool,
  workspaceId: string,
  agentId: string,
  paymentId: string,
  leaseDurationSeconds: number
): Promise<boolean> {
  const result = await db.query(
    `
      INSERT INTO x402_inflight (workspace_id, agent_id, payment_id, lease_expires_at)
      VALUES ($1, $2, $3, now() + ($4 * interval '1 second'))
      ON CONFLICT (workspace_id, agent_id)
      DO UPDATE SET
        payment_id = EXCLUDED.payment_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        created_at = now()
      WHERE x402_inflight.lease_expires_at <= now()
      RETURNING payment_id
    `,
    [workspaceId, agentId, paymentId, leaseDurationSeconds]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function releaseInflightLease(
  db: Pool,
  workspaceId: string,
  agentId: string,
  paymentId: string
): Promise<void> {
  await db.query(
    `
      DELETE FROM x402_inflight
      WHERE workspace_id = $1
        AND agent_id = $2
        AND payment_id = $3
    `,
    [workspaceId, agentId, paymentId]
  );
}

export async function findTransactionByPaymentId(
  db: Pool,
  workspaceId: string,
  paymentId: string
): Promise<X402TransactionRecord | null> {
  const result = await db.query<X402TransactionRow>(
    `
      SELECT
        id,
        workspace_id,
        agent_id,
        payment_id,
        request_hash,
        quoted_amount_cents,
        quoted_currency,
        quoted_asset_symbol,
        quoted_asset_amount,
        scheme,
        network_id,
        resource_type,
        resource_id,
        tx_hash,
        facilitator_url,
        quote_expires_at,
        status,
        settled_at,
        response_cache,
        response_cache_expires_at,
        created_at
      FROM x402_transactions
      WHERE workspace_id = $1
        AND payment_id = $2
      LIMIT 1
    `,
    [workspaceId, paymentId]
  );

  return result.rows[0] ? toTransactionRecord(result.rows[0]) : null;
}

export async function insertPendingTransaction(
  db: Pool,
  input: {
    workspaceId: string;
    agentId: string;
    paymentId: string;
    requestHash: string;
    quote: X402Quote;
    facilitatorUrl: string | null;
  }
): Promise<void> {
  await db.query(
    `
      INSERT INTO x402_transactions (
        workspace_id,
        agent_id,
        payment_id,
        request_hash,
        quoted_amount_cents,
        quoted_currency,
        quoted_asset_symbol,
        quoted_asset_amount,
        scheme,
        network_id,
        resource_type,
        facilitator_url,
        quote_expires_at,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'USD', 'USDC', $6, 'exact', $7, 'secret_exchange', $8, to_timestamp($9), 'pending')
      ON CONFLICT (workspace_id, payment_id)
      DO NOTHING
    `,
    [
      input.workspaceId,
      input.agentId,
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

export async function markTransactionVerified(
  db: Pool,
  workspaceId: string,
  paymentId: string
): Promise<void> {
  await db.query(
    `
      UPDATE x402_transactions
      SET status = 'verified'
      WHERE workspace_id = $1
        AND payment_id = $2
        AND status = 'pending'
    `,
    [workspaceId, paymentId]
  );
}

export async function markTransactionFailed(
  db: Pool,
  workspaceId: string,
  paymentId: string
): Promise<void> {
  await db.query(
    `
      UPDATE x402_transactions
      SET status = 'failed'
      WHERE workspace_id = $1
        AND payment_id = $2
        AND status != 'settled'
    `,
    [workspaceId, paymentId]
  );
}

export async function markTransactionSettled(
  db: Pool,
  input: {
    workspaceId: string;
    paymentId: string;
    resourceId: string;
    txHash: string;
    responseCache: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `
      UPDATE x402_transactions
      SET status = 'settled',
          resource_id = $3,
          tx_hash = $4,
          settled_at = now(),
          response_cache = $5::jsonb,
          response_cache_expires_at = $6
      WHERE workspace_id = $1
        AND payment_id = $2
    `,
    [
      input.workspaceId,
      input.paymentId,
      input.resourceId,
      input.txHash,
      JSON.stringify(input.responseCache),
      cacheExpiry()
    ]
  );
}

export async function listX402Transactions(
  db: Pool,
  workspaceId: string,
  input: { limit?: number; cursor?: string; agentId?: string } = {}
): Promise<X402TransactionPage> {
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit ?? 20, 1), 100) : 20;
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;

  if (input.cursor) {
    const decoded = decodePageCursor(input.cursor);
    cursorCreatedAt = decoded.createdAt;
    cursorId = decoded.id;
  }

  const values: Array<string | number | Date> = [workspaceId];
  const clauses = ["workspace_id = $1"];

  if (input.agentId) {
    values.push(input.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }

  if (cursorCreatedAt && cursorId) {
    values.push(cursorCreatedAt, cursorId);
    clauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
  }

  values.push(limit + 1);

  const result = await db.query<X402TransactionRow>(
    `
      SELECT
        id,
        workspace_id,
        agent_id,
        payment_id,
        request_hash,
        quoted_amount_cents,
        quoted_currency,
        quoted_asset_symbol,
        quoted_asset_amount,
        scheme,
        network_id,
        resource_type,
        resource_id,
        tx_hash,
        facilitator_url,
        quote_expires_at,
        status,
        settled_at,
        response_cache,
        response_cache_expires_at,
        created_at
      FROM x402_transactions
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `,
    values
  );

  const rows = result.rows.slice(0, limit);
  const nextCursor = result.rows.length > limit
    ? encodePageCursor({
        createdAt: rows[rows.length - 1]!.created_at,
        id: rows[rows.length - 1]!.id
      })
    : null;

  return {
    transactions: rows.map(toTransactionRecord),
    nextCursor
  };
}
