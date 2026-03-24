import { randomUUID } from "node:crypto";

export interface RequestSecretParams {
  description: string;
  publicKey: string;
}

export interface RequestSecretResult {
  requestId: string;
  confirmationCode: string;
  secretUrl: string;
}

export interface PollStatusResult {
  status: "submitted";
  retrieveByMs: number;
}

export interface CreateExchangeRequestParams {
  publicKey: string;
  secretName: string;
  purpose: string;
  fulfillerHint: string;
  priorExchangeId?: string;
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

export interface X402PaymentProvider {
  createPayment(input: {
    paymentIdentifier: string;
    paymentRequired: X402PaymentRequired;
  }): Promise<string> | string;
}

export interface X402BudgetProvider {
  getRemainingBudgetCents(input: {
    paymentRequired: X402PaymentRequired;
  }): Promise<number> | number;
}

export interface CreateExchangeRequestResult {
  exchangeId: string;
  status: "pending" | "pending_approval";
  expiresAt: number;
  fulfillmentToken: string;
}

export type ExchangeStatus = "pending" | "reserved" | "submitted" | "retrieved" | "revoked" | "expired" | "denied";

export interface PollExchangeStatusResult {
  status: "submitted";
}

export interface FulfillExchangeResult {
  exchangeId: string;
  status: "reserved";
  requesterId: string;
  requesterPublicKey: string;
  secretName: string;
  purpose: string;
  fulfilledBy: string;
  expiresAt: number;
}

interface SpsClientOptions {
  baseUrl: string;
  gatewayBearerToken: string;
  fetchImpl?: typeof fetch;
  x402PaymentProvider?: X402PaymentProvider;
  x402BudgetProvider?: X402BudgetProvider;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SpsClient {
  private readonly baseUrl: string;

  private readonly token: string;

  private readonly fetchImpl: typeof fetch;

  private readonly x402PaymentProvider?: X402PaymentProvider;

  private readonly x402BudgetProvider?: X402BudgetProvider;

  constructor(options: SpsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.gatewayBearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.x402PaymentProvider = options.x402PaymentProvider;
    this.x402BudgetProvider = options.x402BudgetProvider;
  }

  private async exchangeRequest(
    params: CreateExchangeRequestParams,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api/v2/secret/exchange/request`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...extraHeaders
      },
      body: JSON.stringify({
        public_key: params.publicKey,
        secret_name: params.secretName,
        purpose: params.purpose,
        fulfiller_hint: params.fulfillerHint,
        prior_exchange_id: params.priorExchangeId
      })
    });
  }

  private parsePaymentRequiredHeader(headerValue: string): X402PaymentRequired {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as X402PaymentRequired;
  }

  async requestSecret(params: RequestSecretParams): Promise<RequestSecretResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/request`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        public_key: params.publicKey,
        description: params.description
      })
    });

    if (!response.ok) {
      throw new Error(`SPS request failed with status ${response.status}`);
    }

    const payload = await response.json();
    return {
      requestId: payload.request_id,
      confirmationCode: payload.confirmation_code,
      secretUrl: payload.secret_url
    };
  }

  async getStatus(requestId: string): Promise<"pending" | "submitted" | "expired"> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/status/${requestId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`
      }
    });

    if (response.status === 410) {
      return "expired";
    }

    if (!response.ok) {
      throw new Error(`SPS status failed with status ${response.status}`);
    }

    const payload = await response.json();
    return payload.status;
  }

  async pollStatus(
    requestId: string,
    intervalMs = 1000,
    pendingTimeoutMs = 180000,
    retrieveGraceMs = 60000
  ): Promise<PollStatusResult> {
    const startedAtMs = Date.now();
    const pendingDeadlineMs = startedAtMs + pendingTimeoutMs;
    let delayMs = intervalMs;

    while (true) {
      const status = await this.getStatus(requestId);
      if (status === "submitted") {
        return {
          status: "submitted",
          retrieveByMs: Date.now() + retrieveGraceMs
        };
      }

      if (status === "expired" || Date.now() >= pendingDeadlineMs) {
        throw new Error("User did not provide the secret in time. Ask the user if they still want to proceed.");
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 10000);
    }
  }

  async retrieveSecret(requestId: string): Promise<{ enc: string; ciphertext: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/retrieve/${requestId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`
      }
    });

    if (response.status === 410) {
      throw new Error("Secret no longer available");
    }

    if (!response.ok) {
      throw new Error(`SPS retrieve failed with status ${response.status}`);
    }

    return response.json();
  }

  async createExchangeRequest(params: CreateExchangeRequestParams): Promise<CreateExchangeRequestResult> {
    let response = await this.exchangeRequest(params);

    if (response.status === 402) {
      const paymentRequiredHeader = response.headers.get("payment-required");
      if (!paymentRequiredHeader) {
        throw new Error("SPS requires payment but did not include PAYMENT-REQUIRED details.");
      }

      const paymentRequired = this.parsePaymentRequiredHeader(paymentRequiredHeader);
      const quotedAmountCents = paymentRequired.metadata?.quoted_amount_cents;
      if (!Number.isFinite(quotedAmountCents)) {
        throw new Error("SPS returned an invalid x402 quote.");
      }

      if (this.x402BudgetProvider) {
        const remainingBudgetCents = await this.x402BudgetProvider.getRemainingBudgetCents({ paymentRequired });
        if (!Number.isFinite(remainingBudgetCents) || remainingBudgetCents < quotedAmountCents) {
          throw new Error(`x402 payment exceeds the configured local budget (${quotedAmountCents} cents required).`);
        }
      }

      if (!this.x402PaymentProvider) {
        throw new Error("SPS exchange request requires payment but no x402 payment provider is configured.");
      }

      const paymentIdentifier = randomUUID();
      const paymentSignature = await this.x402PaymentProvider.createPayment({
        paymentIdentifier,
        paymentRequired
      });

      response = await this.exchangeRequest(params, {
        "payment-identifier": paymentIdentifier,
        "payment-signature": paymentSignature
      });
    }

    if (!response.ok) {
      if (response.status === 403) {
        const payload = await response.json().catch(() => ({}));
        if (payload.error === "Exchange requires human approval" || payload.policy?.approval_required) {
          return {
            exchangeId: "",
            status: "pending_approval",
            expiresAt: 0,
            fulfillmentToken: ""
          };
        }
        console.warn(`[SpsClient] 403 Forbidden: ${JSON.stringify(payload)}`);
      }
      throw new Error(`SPS exchange request failed with status ${response.status}`);
    }

    const payload = await response.json();
    return {
      exchangeId: payload.exchange_id,
      status: payload.status,
      expiresAt: payload.expires_at,
      fulfillmentToken: payload.fulfillment_token
    };
  }

  async getExchangeStatus(exchangeId: string): Promise<ExchangeStatus> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/exchange/status/${exchangeId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`
      }
    });

    if (response.status === 410) {
      return "expired";
    }

    if (!response.ok) {
      throw new Error(`SPS exchange status failed with status ${response.status}`);
    }

    const payload = await response.json();
    return payload.status;
  }

  async revokeExchange(exchangeId: string): Promise<boolean> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/exchange/revoke/${exchangeId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${this.token}`
      }
    });

    if (response.status === 410) {
      return false;
    }

    if (!response.ok) {
      throw new Error(`SPS exchange revoke failed with status ${response.status}`);
    }

    return true;
  }

  async pollExchangeStatus(
    exchangeId: string,
    intervalMs = 1000,
    pendingTimeoutMs = 180000,
    reservedTimeoutMs = 30000
  ): Promise<PollExchangeStatusResult> {
    const startedAtMs = Date.now();
    const pendingDeadlineMs = startedAtMs + pendingTimeoutMs;
    let reservedAtMs: number | null = null;
    let delayMs = intervalMs;

    while (true) {
      const status = await this.getExchangeStatus(exchangeId);
      if (status === "submitted") {
        return { status: "submitted" };
      }

      if (status === "reserved") {
        if (reservedAtMs === null) {
          reservedAtMs = Date.now();
        }

        if (Date.now() - reservedAtMs >= reservedTimeoutMs) {
          await this.revokeExchange(exchangeId).catch(() => undefined);
          throw new Error("The fulfiller agent did not complete the exchange in time.");
        }
      } else {
        reservedAtMs = null;
      }

      if (status === "expired" || status === "revoked" || status === "denied" || Date.now() >= pendingDeadlineMs) {
        throw new Error("The secret exchange did not complete in time.");
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 10000);
    }
  }

  async fulfillExchange(fulfillmentToken: string): Promise<FulfillExchangeResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/exchange/fulfill`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        fulfillment_token: fulfillmentToken
      })
    });

    if (!response.ok) {
      throw new Error(`SPS exchange fulfill failed with status ${response.status}`);
    }

    const payload = await response.json();
    return {
      exchangeId: payload.exchange_id,
      status: payload.status,
      requesterId: payload.requester_id,
      requesterPublicKey: payload.requester_public_key,
      secretName: payload.secret_name,
      purpose: payload.purpose,
      fulfilledBy: payload.fulfilled_by,
      expiresAt: payload.expires_at
    };
  }

  async submitExchange(exchangeId: string, params: { enc: string; ciphertext: string }): Promise<{ status: "submitted"; retrieveBy: number }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/exchange/submit/${exchangeId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        enc: params.enc,
        ciphertext: params.ciphertext
      })
    });

    if (!response.ok) {
      throw new Error(`SPS exchange submit failed with status ${response.status}`);
    }

    const payload = await response.json();
    return {
      status: payload.status,
      retrieveBy: payload.retrieve_by
    };
  }

  async retrieveExchange(exchangeId: string): Promise<{ enc: string; ciphertext: string; secretName: string; fulfilledBy: string | null }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/exchange/retrieve/${exchangeId}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`
      }
    });

    if (response.status === 410) {
      throw new Error("Exchange no longer available");
    }

    if (!response.ok) {
      throw new Error(`SPS exchange retrieve failed with status ${response.status}`);
    }

    const payload = await response.json();
    return {
      enc: payload.enc,
      ciphertext: payload.ciphertext,
      secretName: payload.secret_name,
      fulfilledBy: payload.fulfilled_by ?? null
    };
  }
}
