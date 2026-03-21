# Phase 3E Test Plan: Hosted Hardening, Ecosystem & Launch

This document defines the End-to-End (E2E), integration, and operational verification scenarios for the hosted hardening and launch work split out of Phase 3B.

## How To Run

Phase 3E spans `packages/sps-server`, `packages/dashboard`, SDK packaging work, and deployment artifacts.

1. Start local dependencies:
   `docker compose up -d redis postgres`
2. Export the PostgreSQL connection string and enable hosted integration coverage:
   `export DATABASE_URL=postgresql://blindpass:localdev@127.0.0.1:5433/agent_blindpass`
   `export SPS_PG_INTEGRATION=1`
3. Run the server test suites:
   `npm test --workspace=packages/sps-server`
4. Run the dashboard test suites:
   `npm test --workspace=packages/dashboard`

Useful companion commands:

- `npm run dev --workspace=packages/sps-server`
- `npm run dev --workspace=packages/dashboard`
- `npm run test:e2e --workspace=packages/sps-server`

## Milestone 1: Dashboard Session Hardening & Advanced Abuse Controls

- [ ] **Hosted refresh-session cookie migration**
  - [ ] Hosted login and refresh responses set or rotate the refresh token using `Secure` + `httpOnly` cookies
  - [ ] Dashboard auth no longer persists the refresh token in `localStorage` or `sessionStorage`
  - [ ] Page reload and token refresh still work through the cookie-backed hosted session flow
  - [ ] Logout clears the refresh cookie and revokes the backing server-side session
  - [ ] Missing or invalid hosted refresh cookies fail closed without silently restoring the session

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

## Milestone 2: Analytics, SDKs, Documentation & Community

- [ ] **Business-event analytics**
  - [ ] Request volume chart reflects `request_created` audit events
  - [ ] Exchange outcome chart reflects requested/submitted/retrieved/denied/rejected business events
  - [ ] Active agent count reflects distinct agent actors over the configured window
  - [ ] Analytics never exposes secret names, ciphertext, token values, or per-agent identities

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
- [ ] Hosted login / refresh / logout work correctly with secure cookie-backed session auth at production URLs
- [ ] No refresh token is readable from JS-accessible browser storage after hosted login
- [ ] A throttled workspace does not impact the performance or rate limits of other active workspaces on the same instance
