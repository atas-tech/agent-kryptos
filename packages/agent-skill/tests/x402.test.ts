import { decodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { createX402RuntimeProvidersFromEnv, NodeX402PaymentProvider } from "../src/x402.js";
import type { X402PaymentRequired } from "../src/sps-client.js";

const ORIGINAL_ENV = { ...process.env };

function createPaymentRequired(overrides: Partial<X402PaymentRequired["accepts"][0]> = {}): X402PaymentRequired {
  return {
    accepts: [{
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "50000",
      payTo: "0x0000000000000000000000000000000000000001",
      maxTimeoutSeconds: 300,
      extra: {
        resource: "secret_exchange:ws:agent:stripe.api_key.prod",
        description: "Secret exchange request overage",
        name: "USDC",
        version: "2",
        quoted_amount_cents: 5,
        quoted_currency: "USD",
        quoted_asset_symbol: "USDC",
        quoted_asset_amount: "0.05",
        quote_expires_at: 4_100_000_000
      },
      ...overrides
    }],
    x402Version: 2,
    resource: {
      url: "sps://secret_exchange:ws:agent:stripe.api_key.prod",
      description: "Secret exchange request overage"
    },
    metadata: {
      quoted_amount_cents: 5,
      quoted_currency: "USD",
      quoted_asset_symbol: "USDC",
      quoted_asset_amount: "0.05",
      quote_expires_at: 4_100_000_000
    }
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("NodeX402PaymentProvider", () => {
  it("creates an official x402 payment payload for Base Sepolia exact quotes", async () => {
    const provider = new NodeX402PaymentProvider({
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111"
    });

    const header = await provider.createPayment({
      paymentIdentifier: "pid-123",
      paymentRequired: createPaymentRequired()
    });
    const decoded = decodePaymentSignatureHeader(header);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.accepted.network).toBe("eip155:84532");
    expect(decoded.accepted.amount).toBe("50000");
    expect(decoded.extensions).toMatchObject({
      blindpass: {
        paymentId: "pid-123"
      }
    });
  });

  it("fails closed when SPS asks for an unsupported network", async () => {
    const provider = new NodeX402PaymentProvider({
      privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111"
    });

    await expect(provider.createPayment({
      paymentIdentifier: "pid-unsupported",
      paymentRequired: createPaymentRequired({
        network: "eip155:8453"
      })
    })).rejects.toThrow("Unsupported x402 network");
  });

  it("builds runtime providers from environment", () => {
    process.env.BLINDPASS_X402_PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
    process.env.BLINDPASS_X402_BUDGET_CENTS = "25";

    const providers = createX402RuntimeProvidersFromEnv();

    expect(providers.x402PaymentProvider).toBeDefined();
    expect(providers.x402BudgetProvider).toBeDefined();
  });
});
