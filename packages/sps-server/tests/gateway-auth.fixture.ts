import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

export interface GatewayAuthFixture {
  jwksPath: string;
  jwks: { keys: JWK[] };
  issueToken(options?: {
    agentId?: string;
    ttlSeconds?: number;
    issuer?: string;
    audience?: string;
    claims?: Record<string, unknown>;
  }): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createGatewayAuthFixture(): Promise<GatewayAuthFixture> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sps-jwks-"));
  const jwksPath = path.join(dir, "jwks.json");
  const kid = "test-gateway-kid";

  const { privateKey, publicKey } = await generateKeyPair("Ed25519", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";

  const jwks = { keys: [publicJwk as JWK] };
  await writeFile(jwksPath, JSON.stringify(jwks, null, 2));

  return {
    jwksPath,
    jwks,
    async issueToken(options = {}): Promise<string> {
      const agentId = options.agentId ?? "test-agent";
      const ttlSeconds = options.ttlSeconds ?? 300;
      const issuer = options.issuer ?? "gateway";
      const audience = options.audience ?? "sps";
      const claims = options.claims ?? { role: "gateway" };
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(agentId)
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds)
        .sign(privateKey);
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
