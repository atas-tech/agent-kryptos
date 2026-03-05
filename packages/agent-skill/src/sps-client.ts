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

interface SpsClientOptions {
  baseUrl: string;
  gatewayBearerToken: string;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SpsClient {
  private readonly baseUrl: string;

  private readonly token: string;

  private readonly fetchImpl: typeof fetch;

  constructor(options: SpsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.gatewayBearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
}
