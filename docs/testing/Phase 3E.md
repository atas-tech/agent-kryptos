# Phase 3E Test Plan: Hosted Hardening, Ecosystem & Launch

This document defines the End-to-End (E2E), integration, and operational verification scenarios for the hosted hardening and launch work split out of Phase 3B.

## How To Run

Phase 3E spans `packages/sps-server`, `packages/dashboard`, SDK packaging work, and deployment artifacts.

1. Start local dependencies:
   `docker compose up -d redis postgres`
2. Export the PostgreSQL connection string and enable hosted integration coverage:
   `export DATABASE_URL=postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos`
   `export SPS_PG_INTEGRATION=1`
3. Run the server test suites:
   `npm test --workspace=packages/sps-server`
4. Run the dashboard test suites:
   `npm test --workspace=packages/dashboard`

Useful companion commands:

- `npm run dev --workspace=packages/sps-server`
- `npm run dev --workspace=packages/dashboard`
- `npm run test:e2e --workspace=packages/sps-server`

## Milestone 1: Analytics, Workspace Policy Management & Advanced Abuse Controls

- [ ] **Business-event analytics**
  - [ ] Request volume chart reflects `request_created` audit events
  - [ ] Exchange outcome chart reflects requested/submitted/retrieved/denied/rejected business events
  - [ ] Active agent count reflects distinct agent actors over the configured window
  - [ ] Analytics never exposes secret names, ciphertext, token values, or per-agent identities

- [ ] **Workspace policy API and storage**
  - [ ] `GET /api/v2/workspace/policy` returns only the caller workspace's current policy document and metadata
  - [ ] `PATCH /api/v2/workspace/policy` is restricted to `workspace_admin`
  - [ ] `workspace_operator` can read policy but cannot update it
  - [ ] Policy documents persist in PostgreSQL with versioning and `updated_by_user_id`
  - [ ] Policy audit events do not leak secret values or bootstrap credentials

- [ ] **Workspace policy validation**
  - [ ] Reject a rule whose `secretName` is missing from the secret registry
  - [ ] Reject duplicate `ruleId` values inside one workspace policy document
  - [ ] Reject oversized payloads or field values beyond the documented limits
  - [ ] Reject invalid optimistic-concurrency updates when another admin has already saved a newer version
  - [ ] `POST /api/v2/workspace/policy/validate` returns structured validation failures without persisting state

- [ ] **Workspace policy enforcement**
  - [ ] Updating workspace A policy never changes exchange behavior for workspace B
  - [ ] A newly added `pending_approval` rule affects the next matching exchange request immediately
  - [ ] A removed or changed rule causes stale fulfillments to fail with the expected policy-changed conflict
  - [ ] Existing exchange lifecycle checks continue to enforce same-workspace isolation after policy edits
  - [ ] Hosted mode no longer requires editing `SPS_SECRET_REGISTRY_JSON` or `SPS_EXCHANGE_POLICY_JSON` for per-workspace policy changes

- [ ] **Dashboard policy management**
  - [ ] A `workspace_admin` can add, edit, and remove secret registry entries from the dashboard
  - [ ] A `workspace_admin` can add, edit, and remove exchange rules from the dashboard
  - [ ] Draft validation errors render clearly before save
  - [ ] The dashboard shows current policy version / last-updated metadata
  - [ ] `workspace_operator` can inspect current policy in read-only mode if the route is exposed

- [ ] **Turnstile**
  - [ ] Register/login accepts a valid Turnstile token when configured
  - [ ] Register/login rejects an invalid Turnstile token when configured
  - [ ] Local/dev mode skips Turnstile validation when the secret is unset

- [ ] **Burst throttling**
  - [ ] A workspace exceeding the burst threshold emits an `abuse_alert` audit event
  - [ ] Throttled workspaces are reduced to 1 request/minute
  - [ ] The throttle clears automatically after the window expires
- [ ] **Burst Simulator**
  - [ ] Trigger a 5x quota burst
  - [ ] Verify `abuse_alert` is emitted
  - [ ] Verify the throttle applies only to the affected workspace

## Milestone 2: SDKs, Documentation & Community

- [ ] **Node.js SDK**
  - [ ] Bootstrap API key to JWT minting works against a local hosted SPS
  - [ ] Secret request and retrieval flow succeeds end-to-end
  - [ ] Exchange request, fulfill, submit, and retrieve flow succeeds end-to-end

- [ ] **Python and Go SDKs**
  - [ ] Both SDKs complete the same hosted bootstrap and secret delivery flow
  - [ ] Both SDKs document in-memory-only secret handling expectations

- [ ] **Docs and community artifacts**
  - [ ] Quickstart guide works from a clean machine
  - [ ] OpenAPI references match real route contracts
  - [ ] Policy guide explains the hosted workspace policy model and the self-hosted env bootstrap/default path
  - [ ] Provide a standard SDK integration harness such as `docker-compose.test.yml` or an equivalent mock container setup

## Milestone 3: Hosted Deployment & Domain Cutover

- [ ] `GET /healthz` returns `200`
- [ ] `GET /readyz` returns `200` only when PostgreSQL and Redis are reachable
- [ ] `GET /readyz` returns `503` if Redis is down but PostgreSQL is up, and vice versa
- [ ] Production dashboard, browser UI, and API images build successfully
- [ ] `app.atas.tech`, `secret.atas.tech`, and `sps.atas.tech` serve over valid HTTPS
- [ ] Hosted register → enroll agent → deliver secret flow succeeds at production URLs
- [ ] Refresh token storage is re-reviewed before go-live, including whether `Secure` + `httpOnly` cookies should replace the current MVP storage model
- [ ] A throttled workspace does not impact the performance or rate limits of other active workspaces on the same instance
