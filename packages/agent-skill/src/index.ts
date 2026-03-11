import { decrypt, destroyKeyPair, encrypt, generateKeyPair } from "./key-manager.js";
import { SecretStore } from "./secret-store.js";
import { SpsClient } from "./sps-client.js";

export * from "./key-manager.js";
export * from "./secret-store.js";
export * from "./sps-client.js";

export interface AgentSecretRuntimeOptions {
  spsBaseUrl: string;
  gatewayBearerToken: string;
  fetchImpl?: typeof fetch;
}

export interface RequestExchangeParams {
  secretName: string;
  purpose: string;
  fulfillerHint: string;
  deliverToken: (fulfillmentToken: string) => Promise<void>;
  reservedTimeoutMs?: number;
}

export class SecretMissingError extends Error {
  constructor(secretName: string) {
    super(`Secret '${secretName}' is missing from memory. Use the 'request_secret' tool with 're_request: true' to ask the user to re-enter it.`);
    this.name = 'SecretMissingError';
  }
}

export class AgentSecretRuntime {
  readonly store = new SecretStore();

  private readonly client: SpsClient;

  constructor(options: AgentSecretRuntimeOptions) {
    this.client = new SpsClient({
      baseUrl: options.spsBaseUrl,
      gatewayBearerToken: options.gatewayBearerToken,
      fetchImpl: options.fetchImpl
    });
  }

  checkSecretOrThrow(secretName: string): Buffer {
    const value = this.store.get(secretName);
    if (!value) {
      throw new SecretMissingError(secretName);
    }
    return value;
  }

  async requestAndStoreSecret(secretName: string, description: string): Promise<{ requestId: string; confirmationCode: string; secretUrl: string }> {
    const keyPair = await generateKeyPair();

    try {
      const request = await this.client.requestSecret({
        description,
        publicKey: keyPair.publicKey
      });

      const pollResult = await this.client.pollStatus(request.requestId);
      const retrieved = await this.client.retrieveSecret(request.requestId);

      if (Date.now() > pollResult.retrieveByMs) {
        throw new Error("Secret no longer available");
      }

      const plaintext = await decrypt(keyPair.privateKey, retrieved.enc, retrieved.ciphertext);
      this.store.storeSecret(secretName, plaintext);

      return request;
    } finally {
      destroyKeyPair(keyPair);
    }
  }

  async requestAndStoreExchangeSecret(params: RequestExchangeParams): Promise<{ exchangeId: string; fulfilledBy: string | null }> {
    const keyPair = await generateKeyPair();

    try {
      const created = await this.client.createExchangeRequest({
        publicKey: keyPair.publicKey,
        secretName: params.secretName,
        purpose: params.purpose,
        fulfillerHint: params.fulfillerHint
      });

      await params.deliverToken(created.fulfillmentToken);
      await this.client.pollExchangeStatus(created.exchangeId, 1000, 180000, params.reservedTimeoutMs ?? 30000);

      const retrieved = await this.client.retrieveExchange(created.exchangeId);
      const plaintext = await decrypt(keyPair.privateKey, retrieved.enc, retrieved.ciphertext);
      this.store.storeSecret(params.secretName, plaintext);

      return {
        exchangeId: created.exchangeId,
        fulfilledBy: retrieved.fulfilledBy
      };
    } finally {
      destroyKeyPair(keyPair);
    }
  }

  async fulfillExchange(fulfillmentToken: string): Promise<{ exchangeId: string; secretName: string }> {
    const reservation = await this.client.fulfillExchange(fulfillmentToken);
    const secret = this.store.get(reservation.secretName);
    if (!secret) {
      throw new SecretMissingError(reservation.secretName);
    }

    const sealed = await encrypt(reservation.requesterPublicKey, secret);
    await this.client.submitExchange(reservation.exchangeId, sealed);

    return {
      exchangeId: reservation.exchangeId,
      secretName: reservation.secretName
    };
  }
}
