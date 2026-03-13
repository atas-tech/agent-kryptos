# Phase 3B Test Plan: UI Dashboard, Operations, SDKs & Community

This document defines the End-to-End (E2E), integration, and component verification scenarios for Phase 3B.

## How To Run

Phase 3B spans both `packages/sps-server` and the new `packages/dashboard` package.

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

## Milestone 1: Dashboard UI Design

- [x] All 14 Stitch screens exist in project `5937100388262572555`
- [x] The admin-only Dashboard Home screen is visually distinct from role-specific list pages
- [x] Shared layout, spacing, status badges, and modal patterns are consistent across screens
- [x] Mobile navigation collapse is designed and reviewed
- [x] Desktop variants (1280px) generated and verified for all 14 screens

## Milestone 2: Dashboard Shell & Authentication UI

- [ ] **Auth lifecycle**
  - [ ] Admin registers a new workspace from the dashboard
  - [ ] Admin is redirected into the authenticated shell
- [ ] Admin logout clears in-memory access state and persisted refresh token
- [ ] Admin logout invalidates the refresh token on the server
- [ ] Refresh flow rotates tokens and keeps the session alive after page reload
- [ ] **Security check**: Verify access tokens are NOT stored in `localStorage` or `sessionStorage`

- [ ] **Force password change**
  - [ ] Admin creates a member with a temporary password
  - [ ] That member logs in and is redirected to `/change-password`
  - [ ] That member cannot access role pages until password change succeeds

- [ ] **Role-based routing**
  - [ ] `workspace_admin` can access the admin-only home route
  - [ ] `workspace_operator` is redirected away from the home route to `/agents`
  - [ ] `workspace_viewer` is redirected away from the home route to `/audit`
  - [ ] Sidebar navigation hides disallowed pages for each role

## Milestone 3: Agent & Member Management UI

- [ ] **Agent management**
  - [ ] Admin enrolls an agent and sees the bootstrap API key exactly once
  - [ ] Operator enrolls an agent successfully
  - [ ] Rotating an API key invalidates the previous key and reveals the replacement once
  - [ ] Revoking an agent removes it from active workflows

- [ ] **Member management**
  - [ ] Admin creates a member with a valid temporary password
  - [ ] Admin changes a member role
  - [ ] Admin suspends a member
  - [ ] Last-admin lockout disables self-demotion or suspension when only one active admin remains
- [ ] **RBAC Enforcement**: Verify `workspace_viewer` receives `403 Forbidden` when attempting to CREATE or UPDATE agents/members via direct API calls
- [ ] **Lockout Bypass**: Verify API explicitly rejects demoting the last admin even if the request is formatted correctly

- [ ] **Paginated backend list support**
  - [ ] `GET /api/v2/agents` returns `next_cursor` and stable pagination order
  - [ ] `GET /api/v2/members` returns `next_cursor` and stable pagination order
  - [ ] Dashboard tables append subsequent pages without duplicating rows

## Milestone 4: Audit Log Viewer & Approvals Inbox

- [ ] **Audit viewer**
  - [ ] Admin, operator, and viewer can load the audit page
  - [ ] Audit filters by event type, actor type, resource id, and date range work correctly
  - [ ] `GET /api/v2/audit` paginates with `next_cursor`
  - [ ] Expanded audit rows never expose ciphertext, bootstrap API keys, or temporary passwords
- [ ] **Data Masking**: Verify that `api/v2/audit` responses do not contain any `ak_` prefixes or raw secrets in the metadata JSON
- [ ] **Automated Leak Scanner**: Implement a test utility or script that regex-scans recent audit logs for common secret patterns (`ak_`, `sk_`, etc.) and fails if any are found

- [ ] **Exchange drill-down**
  - [ ] Exchange lifecycle pages render requested, reserved, submitted, retrieved, and approval events in order
  - [ ] Exchange drill-down remains workspace-scoped

- [ ] **Approvals inbox**
  - [ ] Admin can approve a pending exchange request
  - [ ] Operator can deny a pending exchange request
  - [ ] Viewer can see pending approvals but cannot approve or deny

## Milestone 5: Billing & Quota Dashboard

- [ ] **Admin-only home summary**
  - [ ] `GET /api/v2/dashboard/summary` returns workspace metadata, tier, billing state, and quota usage
  - [ ] Non-admin roles are forbidden from `GET /api/v2/dashboard/summary`
  - [ ] Dashboard home renders solely from the summary endpoint without fan-out list calls for counts

- [ ] **Billing**
  - [ ] Free-tier admin starts Stripe Checkout from `/billing`
  - [ ] Standard-tier admin opens the Stripe Customer Portal from `/billing`
  - [ ] Non-admin roles cannot access the billing page in the MVP

- [ ] **Quota visualization**
  - [ ] Secret request, agent, and member quota meters show correct usage and thresholds
  - [ ] A2A exchange availability reflects free vs. standard tier correctly

## Milestone 6: Analytics & Advanced Abuse Controls

- [ ] **Business-event analytics**
  - [ ] Request volume chart reflects `request_created` audit events
  - [ ] Exchange outcome chart reflects requested/submitted/retrieved/denied/rejected business events
  - [ ] Active agent count reflects distinct agent actors over the configured window
  - [ ] Analytics never exposes secret names, ciphertext, token values, or per-agent identities

- [ ] **Turnstile**
  - [ ] Register/login accepts a valid Turnstile token when configured
  - [ ] Register/login rejects an invalid Turnstile token when configured
  - [ ] Local/dev mode skips Turnstile validation when the secret is unset

- [ ] **Burst throttling**
  - [ ] A workspace exceeding the burst threshold emits an `abuse_alert` audit event
  - [ ] Throttled workspaces are reduced to 1 request/minute
  - [ ] The throttle clears automatically after the window expires
- [ ] **Burst Simulator**: Run script to trigger 5× quota burst; verify `abuse_alert` event and 1 req/min limit is enforced for exactly the affected workspace

## Milestone 7: SDKs, Documentation & Community

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
  - [ ] **SDK Test Harness**: Provide a standard `docker-compose.test.yml` or mock container that SDK developers can use to run integration tests without a full production environment

## Milestone 8: Hosted Deployment & Domain Cutover

- [ ] `GET /healthz` returns `200`
- [ ] `GET /readyz` returns `200` only when PostgreSQL and Redis are reachable
- [ ] **Partial Failure**: Verify `readyz` returns `503` if Redis is down but Postgres is up (and vice versa)
- [ ] Production dashboard, browser UI, and API images build successfully
- [ ] `app.atas.tech`, `secret.atas.tech`, and `sps.atas.tech` serve over valid HTTPS
- [ ] Hosted register → enroll agent → deliver secret flow succeeds at production URLs
- [ ] **Final Security Audit**: Re-evaluate and implement `Secure` + `httpOnly` cookie fallback for refresh tokens before final go-live
- [ ] **Throttling Isolation**: Verify that a throttled workspace does NOT impact the performance or rate limits of other active workspaces on the same instance

