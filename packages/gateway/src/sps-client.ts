export interface CreateSecretRequestInput {
  description: string;
  publicKey: string;
}

export interface CreateSecretRequestResult {
  requestId: string;
  confirmationCode: string;
  secretUrl: string;
}

export interface GatewaySpsClientOptions {
  baseUrl: string;
  gatewayBearerToken: string;
  fetchImpl?: typeof fetch;
}

export class GatewaySpsClient {
  private readonly baseUrl: string;

  private readonly token: string;

  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewaySpsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.gatewayBearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createSecretRequest(input: CreateSecretRequestInput): Promise<CreateSecretRequestResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v2/secret/request`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        public_key: input.publicKey,
        description: input.description
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
}
