import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { buildApp } from "../packages/sps-server/dist/index.js";
import { GatewaySpsClient } from "../packages/gateway/dist/sps-client.js";
import { RequestSecretInterceptor } from "../packages/gateway/dist/interceptor.js";
import { issueJwt, loadOrCreateGatewayIdentity, writeJwksFile } from "../packages/gateway/dist/identity.js";
import { decrypt, destroyKeyPair, generateKeyPair } from "../packages/agent-skill/dist/key-manager.js";
import { SpsClient } from "../packages/agent-skill/dist/sps-client.js";

const suite = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Chacha20Poly1305
});

function toBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function simulateHumanSubmit(secretUrl, plaintext, fetchImpl) {
  const url = new URL(secretUrl);
  const requestId = url.searchParams.get("id");
  const metadataSig = url.searchParams.get("metadata_sig");
  const submitSig = url.searchParams.get("submit_sig");

  if (!requestId || !metadataSig || !submitSig) {
    throw new Error("Secret URL is missing request_id or scoped signatures");
  }

  const metadataRes = await fetchImpl(`${url.origin}/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`);
  if (!metadataRes.ok) {
    throw new Error(`Metadata request failed: ${metadataRes.status}`);
  }

  const metadata = await metadataRes.json();
  const publicKeyBytes = Buffer.from(metadata.public_key, "base64");
  const recipientPublicKey = await suite.kem.deserializePublicKey(
    publicKeyBytes.buffer.slice(publicKeyBytes.byteOffset, publicKeyBytes.byteOffset + publicKeyBytes.byteLength)
  );

  const sealed = await suite.seal(
    { recipientPublicKey },
    new TextEncoder().encode(plaintext).buffer
  );

  const submitRes = await fetchImpl(
    `${url.origin}/api/v2/secret/submit/${requestId}?sig=${encodeURIComponent(submitSig)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enc: toBase64(new Uint8Array(sealed.enc)),
        ciphertext: toBase64(new Uint8Array(sealed.ct))
      })
    }
  );

  if (!submitRes.ok) {
    throw new Error(`Secret submit failed: ${submitRes.status}`);
  }

  return requestId;
}

async function runDemo() {
  process.env.NODE_ENV = "test";
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-demo-"));
  const keyPath = path.join(tempDir, "gateway-key.json");
  const jwksPath = path.join(tempDir, "jwks.json");
  const identity = await loadOrCreateGatewayIdentity({ keyPath });
  await writeJwksFile(identity, jwksPath);
  
  process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = JSON.stringify([
    { name: "gateway-demo", jwks_file: jwksPath, issuer: "gateway", audience: "sps" }
  ]);

  const baseUrl = "http://demo.local";

  const app = await buildApp({
    useInMemoryStore: true,
    hmacSecret: "demo-hmac-secret",
    baseUrl
  });

  const fetchViaInject = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    let payload;
    if (typeof init.body === "string") {
      payload = init.body;
    } else if (init.body instanceof Uint8Array) {
      payload = Buffer.from(init.body);
    } else if (init.body === undefined || init.body === null) {
      payload = undefined;
    } else {
      payload = String(init.body);
    }

    const response = await app.inject({
      method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers.entries()),
      payload
    });

    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers
    });
  };

  const sentMessages = [];
  const chatAdapter = {
    async sendMessage(channelId, message) {
      sentMessages.push({ channelId, message });
      console.log(`\n[ChatAdapter -> ${channelId}]\n${message}\n`);
    }
  };

  const gatewayClient = new GatewaySpsClient({
    baseUrl,
    gatewayBearerToken: await issueJwt(identity, "demo-agent"),
    fetchImpl: fetchViaInject
  });

  const interceptor = new RequestSecretInterceptor({
    spsClient: gatewayClient,
    chatAdapter
  });

  const keyPair = await generateKeyPair();

  try {
    const llmResponse = await interceptor.interceptToolCall("request_secret", {
      description: "Demo API token for integration testing",
      public_key: keyPair.publicKey,
      channel_id: "demo-channel"
    });

    if (!llmResponse) {
      throw new Error("Interceptor did not handle request_secret tool call");
    }

    console.log("[LLM-visible response]");
    console.log(JSON.stringify(llmResponse, null, 2));

    const lastMessage = sentMessages.at(-1)?.message;
    if (!lastMessage) {
      throw new Error("Chat adapter did not receive message");
    }

    const linkMatch = lastMessage.match(/Open link:\s*(\S+)/);
    if (!linkMatch?.[1]) {
      throw new Error("Could not parse secret URL from chat message");
    }

    const agentClient = new SpsClient({
      baseUrl,
      gatewayBearerToken: await issueJwt(identity, "demo-agent"),
      fetchImpl: fetchViaInject
    });

    const pollPromise = agentClient.pollStatus(llmResponse.request_id, 200, 10000, 60000);

    const submittedRequestId = await simulateHumanSubmit(linkMatch[1], "super-secret-demo-value", fetchViaInject);
    console.log(`[Human simulation] Submitted encrypted secret for request ${submittedRequestId}`);

    await pollPromise;

    const payload = await agentClient.retrieveSecret(llmResponse.request_id);
    const plaintext = await decrypt(keyPair.privateKey, payload.enc, payload.ciphertext);

    console.log("[Agent decrypted secret]");
    console.log(plaintext.toString("utf8"));

    if (plaintext.toString("utf8") !== "super-secret-demo-value") {
      throw new Error("Decrypted secret mismatch");
    }

    console.log("\nDemo completed successfully.");
  } finally {
    destroyKeyPair(keyPair);
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

runDemo().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
