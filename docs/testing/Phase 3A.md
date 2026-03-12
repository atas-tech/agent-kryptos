# Phase 3A Test Plan: Hosted Managed Platform

This document outlines the End-to-End (E2E) testing scenarios for Phase 3A of the Agent Kryptos project.

## How To Run

Phase 3A E2E coverage is PostgreSQL-backed and is skipped unless `DATABASE_URL` and `SPS_PG_INTEGRATION=1` are set.

1. Start local dependencies:
   `docker compose up -d redis postgres`
2. Export the PostgreSQL connection string:
   `export DATABASE_URL=postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos`
3. Run the SPS E2E suite:
   `npm run test:e2e --workspace=packages/sps-server`

Useful companion commands:
- `npm run test:db --workspace=packages/sps-server`
- `npm test --workspace=packages/sps-server`

## Milestone 1-3: Foundation & Core Identity
- [x] Covered by unit and integration tests in `tests/db.test.ts`, `tests/auth-routes.test.ts`, `tests/exchange-routes.test.ts`

## Milestone 4: Agent Enrollment, Bootstrap Auth & RBAC

- [x] **Agent Enrollment Lifecycle**
    - [x] Human registers, verifies email, and logs in.
    - [x] Human creates an agent named `test-agent`.
    - [x] Human receives the bootstrap API key.
    - [x] Agent uses the API key to exchange for a short-lived JWT.
    - [x] Agent uses the JWT to store and retrieve a secret.
    - [x] Agent bootstrap key rotation invalidates the old key and activates the new key.
    - [x] Revoked agent credentials can no longer mint JWTs.
    - [x] A revoked `agent_id` can be re-enrolled in the same workspace.

- [x] **RBAC & Member Management**
    - [x] Admin creates an `operator` user.
    - [x] Operator logs in and successfully enrolls a new agent.
    - [x] Operator attempts an admin-only member-management action and fails.
    - [x] Admin demotes Operator to `viewer`.
    - [x] Viewer attempts to enroll an agent and fails with `403 Forbidden`.
    - [x] Verify last-admin lockout prevention (an admin cannot demote/delete themselves if they are the only active admin).

- [x] **Workspace Isolation**
    - [x] Workspace A enrolls `agent-A`.
    - [x] Workspace B enrolls `agent-B`.
    - [x] Workspace B agent tries to retrieve a secret from Workspace A (should fail).
    - [x] Cross-workspace exchange/fulfillment denial remains covered in `tests/exchange-routes.test.ts`.

- [x] **Token Refresh & Access Control**
    - [x] Human logs out (revokes session).
    - [x] Human refresh token becomes unusable after logout.
    - [x] An already-issued access token remains valid until TTL expiry after logout.
    - [x] Unverified workspace owner is blocked from high-risk actions such as agent enrollment.

## Milestone 5: Billing & Stripe Integration

- [ ] **Subscription Upgrade Flow**
    - [ ] Workspace admin creates a Stripe Checkout session.
    - [ ] Simulate successful payment via Stripe webhook (`checkout.session.completed`).
    - [ ] Verify workspace tier is upgraded to `standard` and subscription status is `active`.

- [ ] **Subscription Downgrade & Cancellation**
    - [ ] Simulate subscription deletion via Stripe webhook (`customer.subscription.deleted`).
    - [ ] Verify workspace tier reverts to `free` and subscription status is `canceled`.
    - [ ] Verify features restricted to `standard` tier (e.g., A2A exchange) are now blocked for the workspace.

- [ ] **Quota Enforcement (Free Tier)**
    - [ ] Send 10 secret requests (success).
    - [ ] Send 11th secret request (should fail with `429 Too Many Requests`).
    - [ ] Enroll 5 agents (success).
    - [ ] Attempt to enroll 6th agent (should fail with quota exceeded error).

- [ ] **Webhook Security**
    - [ ] Send a mutated or unsigned webhook payload.
    - [ ] Verify the server rejects the payload with `401/403` (Invalid Signature).
    - [ ] Send a replay attack webhook (if Stripe SDK handles it) and verify rejection.

## Milestone 6: Abuse Controls & Hardening

- [ ] **Rate Limiting**
    - [ ] Auth endpoints: Send >10 login attempts in 1 minute from the same IP (should fail with `429`).
    - [ ] Token generation: Send >5 `POST /api/v2/agents/token` requests in 1 minute (should fail with `429`).
    - [ ] Verify `Retry-After` headers are present and correct.

- [ ] **Audit Logging (Workspace Scoped)**
    - [ ] Perform various actions (enroll agent, read secret, change member role).
    - [ ] Operator calls `GET /api/v2/audit`. Verify all actions are logged accurately.
    - [ ] Verify audit records do not contain plaintext secrets or raw tokens.
    - [ ] Workspace A attempts to read Workspace B's audit logs (should fail or return empty).
