import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { getJWKS, issueJwt, loadOrCreateGatewayIdentity, writeJwksFile } from "../src/identity.js";

describe("identity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("loads or creates identity and issues verifiable JWT", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-identity-"));
    tempDirs.push(dir);

    const keyPath = path.join(dir, "gateway-key.json");
    const identity = await loadOrCreateGatewayIdentity({ keyPath });
    const token = await issueJwt(identity, "agent-123", 120);

    const verifier = createLocalJWKSet(getJWKS(identity));
    const { payload } = await jwtVerify(token, verifier, {
      issuer: "gateway",
      audience: "sps"
    });

    expect(payload.sub).toBe("agent-123");
    expect(payload.role).toBe("gateway");
  });

  it("persists keys and can write JWKS file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-identity-"));
    tempDirs.push(dir);

    const keyPath = path.join(dir, "gateway-key.json");
    const jwksPath = path.join(dir, "jwks.json");

    const first = await loadOrCreateGatewayIdentity({ keyPath });
    const second = await loadOrCreateGatewayIdentity({ keyPath });

    expect(first.kid).toBe(second.kid);

    await writeJwksFile(second, jwksPath);
    const raw = await readFile(jwksPath, "utf8");
    const parsed = JSON.parse(raw) as { keys: Array<{ kid: string }> };
    expect(parsed.keys[0]?.kid).toBe(first.kid);
  });
});
