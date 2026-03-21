# Policy Configuration

This guide defines what policy configuration means in agent-BlindPass, which parts belong to a workspace admin, and which parts remain controlled by the platform or self-hosted operator.

## Overview

There are two policy documents:

- `secret registry`: the catalog of known secret names and their classifications
- `exchange policy`: the rules that determine whether one agent may request a secret from another agent, whether approval is required, and which ring or identity constraints apply

## Hosted vs Self-Hosted

### Hosted Phase 3E model

In hosted mode, policy is workspace-scoped state.

- each workspace has its own secret registry and exchange policy
- `workspace_admin` is the only role that can modify that policy
- SPS resolves policy by `workspace_id`
- policy is stored in PostgreSQL and versioned
- policy changes are audited

Hosted workspaces should not require editing process env vars to change policy.

### Self-hosted model

In self-hosted single-tenant deployments, SPS may still be configured from startup env vars:

- `SPS_SECRET_REGISTRY_JSON`
- `SPS_EXCHANGE_POLICY_JSON`

These values are suitable for local development, demos, and single-workspace self-hosted setups. In pooled hosted deployments they are bootstrap/default inputs, not the long-term per-workspace source of truth.

## Secret Registry

The secret registry declares which secret names the workspace recognizes.

### Admin-configurable fields

| Field | Required | Meaning |
|-------|----------|---------|
| `secretName` | yes | Stable secret identifier such as `stripe.api_key.prod` |
| `classification` | yes | Secret class used for policy reasoning and operator review |
| `description` | no | Human-readable explanation of the secret |

### Example

```json
[
  {
    "secretName": "stripe.api_key.prod",
    "classification": "finance",
    "description": "Production Stripe API key for payment operations"
  },
  {
    "secretName": "restricted.secret",
    "classification": "sensitive",
    "description": "Restricted secret requiring manual approval"
  }
]
```

## Exchange Policy

The exchange policy defines which requester and fulfiller identities may exchange a secret, for which purpose, and whether approval is needed.

### Admin-configurable fields

| Field | Required | Meaning |
|-------|----------|---------|
| `ruleId` | yes | Unique stable rule identifier within the workspace |
| `secretName` | yes | Secret this rule applies to; must exist in the secret registry |
| `requesterIds` | no | Exact requester agent IDs allowed by the rule |
| `fulfillerIds` | no | Exact fulfiller agent IDs allowed by the rule |
| `requesterRings` | no | Requester trust rings allowed by the rule |
| `fulfillerRings` | no | Fulfiller trust rings allowed by the rule |
| `purposes` | no | Allowed exchange purposes |
| `sameRing` | no | Require requester and fulfiller to be in the same ring |
| `allowedRings` | no | Restrict same-ring rules to specific rings |
| `mode` | no | `allow`, `pending_approval`, or `deny` |
| `reason` | no | Human-readable reason surfaced in decisions and audit trails |

### Advanced fields

The current engine also supports `approverIds` and `approverRings` for agent-side approval flows. Expose these only if you explicitly want non-human approver agents in the workspace policy model. For a first hosted admin UI, keeping human approval as the default is simpler.

### Example

```json
[
  {
    "ruleId": "finance-to-payments",
    "secretName": "stripe.api_key.prod",
    "requesterRings": ["finance"],
    "fulfillerRings": ["payments"],
    "purposes": ["charge-order"],
    "mode": "allow",
    "reason": "Finance workflows may request payment execution secrets from the payments ring"
  },
  {
    "ruleId": "restricted-approval",
    "secretName": "restricted.secret",
    "requesterRings": ["finance"],
    "fulfillerRings": ["ops"],
    "purposes": ["break-glass"],
    "mode": "pending_approval",
    "reason": "Cross-ring break-glass exchanges require human approval"
  }
]
```

## What Workspace Admins Should Be Able To Configure

- add, edit, and remove secret registry entries
- define exchange allow, deny, and approval-required rules
- choose requester and fulfiller identities or trust rings
- restrict allowed purposes
- test or validate draft policy before saving
- inspect policy version and last-updated metadata

## What Workspace Operators and Viewers Should See

- `workspace_operator`: read-only visibility into current policy, plus the ability to act on approval requests through the normal approval workflow
- `workspace_viewer`: optional read-only visibility if the product later exposes it, but no policy edits or approval actions

## What Workspace Users Must Not Configure

These values are not business policy. They are runtime, security, or platform controls.

- `workspace_id`
- approval references
- policy hashes
- reserved fulfiller bindings created during exchange execution
- JWT issuer, audience, JWKS, or SPIFFE trust settings
- cross-workspace tenancy rules
- rate limits, quotas, billing, audit retention, and cryptographic settings
- exchange lifecycle state such as pending, reserved, submitted, retrieved, or revoked records

## Validation Rules

At minimum, hosted policy management should enforce the following:

- every `secretName` referenced by an exchange rule must exist in the secret registry
- `ruleId` values must be unique within a workspace
- payload size, list size, and string lengths must be bounded
- updates must use optimistic concurrency so one admin does not silently overwrite another
- policy-change audit records must avoid secret values, bootstrap API keys, and ciphertext

## API Shape

Recommended hosted endpoints:

- `GET /api/v2/workspace/policy`
- `PATCH /api/v2/workspace/policy`
- `POST /api/v2/workspace/policy/validate`

Recommended RBAC:

- `workspace_admin`: read and write
- `workspace_operator`: read-only
- `workspace_viewer`: no access by default, or read-only only if product requirements justify it

## Self-Hosted Env Examples

```bash
export SPS_SECRET_REGISTRY_JSON='[{"secretName":"stripe.api_key.prod","classification":"finance"}]'
export SPS_EXCHANGE_POLICY_JSON='[{"ruleId":"allow-stripe","secretName":"stripe.api_key.prod","requesterRings":["finance"],"fulfillerRings":["payments"],"mode":"allow"}]'
```

Use env vars when you control the whole SPS process and want simple startup configuration. Do not model hosted per-workspace policy edits as env-var changes.
