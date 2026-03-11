import { describe, expect, it } from "vitest";
import { ExchangePolicyEngine, hashPolicyDecision } from "../src/services/policy.js";

describe("ExchangePolicyEngine", () => {
  const registry = [
    {
      secretName: "stripe.api_key.prod",
      classification: "credential"
    }
  ];

  it("matches ring-scoped allow rules", () => {
    const engine = new ExchangePolicyEngine(registry, [
      {
        ruleId: "finance-to-payments",
        secretName: "stripe.api_key.prod",
        requesterRings: ["finance"],
        fulfillerRings: ["payments"]
      }
    ]);

    const evaluated = engine.evaluate({
      requesterId: "spiffe://myorg.local/ring/finance/crm-bot",
      secretName: "stripe.api_key.prod",
      purpose: "charge-order",
      fulfillerHint: "spiffe://myorg.local/ring/payments/payment-bot"
    });

    expect(evaluated).toMatchObject({
      allowedFulfillerId: "spiffe://myorg.local/ring/payments/payment-bot",
      decision: {
        mode: "allow",
        approvalRequired: false,
        requesterRing: "finance",
        fulfillerRing: "payments"
      }
    });
  });

  it("matches pending approval rules and hashes them distinctly", () => {
    const engine = new ExchangePolicyEngine(registry, [
      {
        ruleId: "finance-to-ops-approval",
        secretName: "stripe.api_key.prod",
        requesterRings: ["finance"],
        fulfillerRings: ["ops"],
        mode: "pending_approval",
        reason: "cross-ring exchange requires approval"
      }
    ]);

    const evaluated = engine.evaluate({
      requesterId: "spiffe://myorg.local/ring/finance/crm-bot",
      secretName: "stripe.api_key.prod",
      purpose: "charge-order",
      fulfillerHint: "spiffe://myorg.local/ring/ops/deploy-bot"
    });

    expect(evaluated).toMatchObject({
      allowedFulfillerId: null,
      decision: {
        mode: "pending_approval",
        approvalRequired: true,
        reason: "cross-ring exchange requires approval",
        requesterRing: "finance",
        fulfillerRing: "ops"
      }
    });

    const hash = hashPolicyDecision(evaluated!.decision, evaluated!.allowedFulfillerId);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports explicit deny rules", () => {
    const engine = new ExchangePolicyEngine(registry, [
      {
        ruleId: "deny-dev",
        secretName: "stripe.api_key.prod",
        requesterRings: ["dev"],
        mode: "deny"
      }
    ]);

    const evaluated = engine.evaluate({
      requesterId: "spiffe://myorg.local/ring/dev/build-bot",
      secretName: "stripe.api_key.prod",
      purpose: "charge-order",
      fulfillerHint: "spiffe://myorg.local/ring/payments/payment-bot"
    });

    expect(evaluated).toMatchObject({
      allowedFulfillerId: null,
      decision: {
        mode: "deny",
        approvalRequired: false,
        requesterRing: "dev",
        fulfillerRing: "payments"
      }
    });
  });
});
