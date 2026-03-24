import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { mintAgentAccessToken, type EnrolledAgentRecord } from "../src/services/agent.js";
import { userJwtSecret } from "../src/utils/crypto.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalUserJwtSecret = process.env.SPS_USER_JWT_SECRET;
const originalAgentJwtSecret = process.env.SPS_AGENT_JWT_SECRET;
const originalHmacSecret = process.env.SPS_HMAC_SECRET;

const testAgent: EnrolledAgentRecord = {
  id: "agent-row-id",
  workspaceId: "ws-test",
  agentId: "agent-test",
  displayName: "Agent Test",
  status: "active",
  createdAt: new Date(0),
  revokedAt: null
};

describe("secret configuration", () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_USER_JWT_SECRET = originalUserJwtSecret;
    process.env.SPS_AGENT_JWT_SECRET = originalAgentJwtSecret;
    process.env.SPS_HMAC_SECRET = originalHmacSecret;
  });

  it("rejects startup without an explicit HMAC secret outside tests", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.SPS_HMAC_SECRET;

    await expect(buildApp({
      useInMemoryStore: true
    })).rejects.toThrow("SPS_HMAC_SECRET must be configured");
  });

  it("rejects missing user JWT signing secret", () => {
    delete process.env.SPS_USER_JWT_SECRET;

    expect(() => userJwtSecret()).toThrow("SPS_USER_JWT_SECRET must be configured");
  });

  it("rejects missing agent JWT signing secret", async () => {
    delete process.env.SPS_AGENT_JWT_SECRET;

    await expect(mintAgentAccessToken(testAgent)).rejects.toThrow("SPS_AGENT_JWT_SECRET must be configured");
  });
});
