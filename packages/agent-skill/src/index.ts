import { decrypt, destroyKeyPair, generateKeyPair } from "./key-manager.js";
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
}
