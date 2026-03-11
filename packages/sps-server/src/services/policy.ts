import { createHash } from "node:crypto";
import type { PolicyDecision } from "../types.js";

export interface SecretRegistryEntry {
  secretName: string;
  classification: string;
  description?: string;
}

export interface ExchangePolicyRule {
  ruleId: string;
  secretName: string;
  requesterIds?: string[];
  fulfillerIds?: string[];
  purposes?: string[];
  sameRing?: boolean;
  allowedRings?: string[];
  reason?: string;
}

export interface EvaluateExchangePolicyInput {
  requesterId: string;
  secretName: string;
  purpose: string;
  fulfillerHint: string;
}

function normalizeList(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function listIncludes(values: string[] | undefined, candidate: string): boolean {
  if (!values || values.length === 0) {
    return true;
  }
  return values.includes(candidate);
}

function ringFromAgentId(agentId: string): string | null {
  const match = agentId.match(/\/ring\/([^/]+)/);
  return match?.[1] ?? null;
}

export class ExchangePolicyEngine {
  private readonly registry = new Map<string, SecretRegistryEntry>();
  private readonly rules: ExchangePolicyRule[];

  constructor(registryEntries: SecretRegistryEntry[], rules: ExchangePolicyRule[]) {
    for (const entry of registryEntries) {
      this.registry.set(entry.secretName.trim(), {
        secretName: entry.secretName.trim(),
        classification: entry.classification.trim(),
        description: entry.description?.trim() || undefined
      });
    }

    this.rules = rules.map((rule) => ({
      ...rule,
      requesterIds: rule.requesterIds ? normalizeList(rule.requesterIds) : undefined,
      fulfillerIds: rule.fulfillerIds ? normalizeList(rule.fulfillerIds) : undefined,
      purposes: rule.purposes ? normalizeList(rule.purposes) : undefined,
      allowedRings: rule.allowedRings ? normalizeList(rule.allowedRings) : undefined
    }));
  }

  hasSecret(secretName: string): boolean {
    return this.registry.has(secretName);
  }

  getSecret(secretName: string): SecretRegistryEntry | null {
    return this.registry.get(secretName) ?? null;
  }

  evaluate(input: EvaluateExchangePolicyInput): { decision: PolicyDecision; allowedFulfillerId: string } | null {
    const registryEntry = this.registry.get(input.secretName);
    if (!registryEntry) {
      return null;
    }

    const requesterRing = ringFromAgentId(input.requesterId);
    const fulfillerRing = ringFromAgentId(input.fulfillerHint);
    const matchedRule = this.rules.find((rule) => {
      if (rule.secretName !== input.secretName) {
        return false;
      }

      if (rule.requesterIds && !rule.requesterIds.includes(input.requesterId)) {
        return false;
      }

      if (rule.fulfillerIds && !rule.fulfillerIds.includes(input.fulfillerHint)) {
        return false;
      }

      if (!listIncludes(rule.purposes, input.purpose)) {
        return false;
      }

      if (rule.sameRing) {
        if (!requesterRing || !fulfillerRing || requesterRing !== fulfillerRing) {
          return false;
        }
        if (rule.allowedRings && !rule.allowedRings.includes(requesterRing)) {
          return false;
        }
      }

      return true;
    });

    if (!matchedRule) {
      return null;
    }

    return {
      allowedFulfillerId: input.fulfillerHint,
      decision: {
        mode: "allow",
        approvalRequired: false,
        ruleId: matchedRule.ruleId,
        reason: matchedRule.reason ?? `exchange allowed by static policy for ${registryEntry.classification}`,
        approvalReference: null,
        requesterRing,
        fulfillerRing,
        secretName: input.secretName
      }
    };
  }
}

export function hashPolicyDecision(decision: PolicyDecision, allowedFulfillerId: string): string {
  const payload = JSON.stringify({
    mode: decision.mode,
    approvalRequired: decision.approvalRequired,
    ruleId: decision.ruleId,
    reason: decision.reason,
    approvalReference: decision.approvalReference ?? null,
    requesterRing: decision.requesterRing ?? null,
    fulfillerRing: decision.fulfillerRing ?? null,
    secretName: decision.secretName,
    allowedFulfillerId
  });
  return createHash("sha256").update(payload).digest("hex");
}
