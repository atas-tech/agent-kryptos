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

- [x] **E2E: Dashboard Shell & Auth (Playwright)**
  - [x] **Scenario 001: First-time Registration**
    - Navigate to `/register`, fill workspace & owner details.
    - Assert success toast/redirect.
    - Verify `localStorage` does NOT contain access tokens.
    - Verify app shell renders with "Workspace Admin" role features.
  - [x] **Scenario 002: Login & Session Persistence**
    - Log in with verified credentials.
    - Verify redirect to `/` (Admin Home).
    - Reload page; verify session persists via refresh token rotation.
    - Verify deep link to `/agents` persists after login.
  - [x] **Scenario 003: Logout Flow**
    - Click logout in sidebar.
    - Verify redirect to `/login`.
    - Attempt to visit `/` and verify redirect back to `/login`.
  - [x] **Scenario 004: Force Password Change Enforcement**
    - Create a member via API/Admin UI with `force_password_change: true`.
    - Log in as that member.
    - Assert immediate redirect to `/change-password`.
    - Attempt to visit `/agents` (or any other route) and verify redirect back to `/change-password`.
    - Complete password change and verify access to `/agents` is restored.
  - [x] **Scenario 005: Role-based Navigation & Redirects**
    - Log in as `operator`.
    - Verify sidebar *hides* Billing, Settings, and Members.
    - Attempt to visit `/settings` and verify redirect to `/agents` (default for operator).
    - Log in as `viewer`.
    - Verify sidebar *hides* everything except Audit and Analytics.
    - Attempt to visit `/agents` and verify redirect to `/audit`.

## Milestone 3: Agent & Member Management UI

- [ ] **E2E: Agent management (Playwright)**
  - [ ] **Scenario 301: Admin enrolls an agent and reveals the bootstrap key once**
    - Log in as `workspace_admin`.
    - Navigate to `/agents`.
    - Open the enroll modal adapted from the Stitch agent-enroll screen.
    - Submit `agent_id` and optional `display_name`.
    - Assert the returned `ak_` key is rendered in `ApiKeyReveal`.
    - Copy the key and confirm the "I've saved this key" acknowledgement.
    - Close/reopen the modal and refresh the page.
    - Verify the previously revealed key is no longer visible anywhere in the UI.
  - [ ] **Scenario 302: Operator can enroll and revoke agents**
    - Log in as `workspace_operator`.
    - Navigate to `/agents`.
    - Enroll an agent successfully.
    - Revoke that agent from the row action menu.
    - Verify the row status changes to `revoked` and the agent is excluded from active-only filters.
  - [ ] **Scenario 303: Rotate key invalidates the previous credential**
    - Enroll an agent and store the first bootstrap key in the test.
    - Trigger Rotate Key from the agent row.
    - Verify the replacement key is revealed once.
    - Call `POST /api/v2/agents/token` with the old key and assert `401`.
    - Call `POST /api/v2/agents/token` with the new key and assert success.
  - [ ] **Scenario 304: Viewer is denied access to agent management**
    - Log in as `workspace_viewer`.
    - Attempt to visit `/agents`.
    - Verify route guard redirects away from the page.
    - Attempt direct agent create/rotate/revoke API calls and verify `403 Forbidden`.

- [ ] **E2E: Member management (Playwright)**
  - [ ] **Scenario 305: Admin creates a member with a temporary password**
    - Log in as `workspace_admin`.
    - Navigate to `/members`.
    - Open the add-member flow adapted from the Stitch members screen.
    - Enter a valid email, role, and temporary password with at least 12 characters.
    - Verify the new member row appears with `force_password_change = true`.
    - Log in as that member and verify redirect to `/change-password`.
  - [ ] **Scenario 306: Admin updates role and suspended status**
    - Change a member from `workspace_viewer` to `workspace_operator`.
    - Verify the role badge updates in the table without a full page reload.
    - Suspend the same member.
    - Verify the row status changes to `suspended` and the member can no longer authenticate.
  - [ ] **Scenario 307: Last-admin lockout is enforced in UI and API**
    - Create a workspace with exactly one active admin.
    - Navigate to `/members`.
    - Verify that demote/suspend controls for that admin are disabled in the UI.
    - Attempt the same state transition via direct API call.
    - Verify the server rejects it with the last-admin lockout error.

- [ ] **E2E: Workspace settings (Playwright)**
  - [ ] **Scenario 308: Admin updates workspace display name and sees owner verification status**
    - Log in as `workspace_admin`.
    - Navigate to `/settings`.
    - Verify slug and tier render as read-only fields.
    - Verify owner email verification state is displayed clearly.
    - Update the display name.
    - Reload the page and verify the new display name persists in both header chrome and settings form.

- [ ] **Server integration: `packages/sps-server`**
  - [ ] **Scenario 309: `GET /api/v2/agents` paginates with stable ordering**
    - Seed more agents than one page can hold.
    - Fetch page 1 with `limit`.
    - Fetch page 2 using `next_cursor`.
    - Verify no duplicates, deterministic ordering, and correct `next_cursor` exhaustion.
  - [ ] **Scenario 310: `GET /api/v2/members` paginates with stable ordering**
    - Seed more members than one page can hold.
    - Fetch consecutive pages via cursor.
    - Verify no duplicates and deterministic ordering.
  - [ ] **Scenario 311: Agent list/status filters are workspace-scoped**
    - Seed agents across two workspaces with mixed statuses.
    - Verify `status=active` and `status=revoked` only return records from the caller workspace.
  - [ ] **Scenario 312: Member list/status filters are workspace-scoped**
    - Seed members across two workspaces with mixed statuses.
    - Verify `status=active` and `status=suspended` only return records from the caller workspace.
  - [ ] **Scenario 313: Last-admin lockout rejects bypass attempts**
    - Attempt to demote, suspend, and delete the final active admin using correctly formed requests.
    - Verify each request is rejected with the lockout error code.
  - [ ] **Scenario 314: Workspace read contract exposes owner verification status**
    - Call `GET /api/v2/workspace`.
    - Verify the response includes the owner verification field required by `/settings`.

- [ ] **Dashboard component tests: `packages/dashboard`**
  - [ ] **Scenario 315: `ApiKeyReveal` copies and dismisses without persistence**
    - Render `ApiKeyReveal` with an `ak_` key.
    - Verify copy-to-clipboard is called.
    - Verify dismissal requires acknowledgement and unmount removes the key from view.
  - [ ] **Scenario 316: Agent table appends paginated rows without duplication**
    - Mock two cursor pages from `GET /api/v2/agents`.
    - Trigger load-more/infinite append behavior.
    - Verify rows merge once and preserve sort order.
  - [ ] **Scenario 317: Member create form enforces temporary password rules**
    - Verify fewer than 12 characters is blocked client-side.
    - Verify visibly weak temporary passwords show an error state before submit.
  - [ ] **Scenario 318: Last-admin controls disable correctly**
    - Render the members table with exactly one active admin.
    - Verify demote/suspend controls are disabled for that row.
  - [ ] **Scenario 319: Settings page uses workspace contract and role rules correctly**
    - Verify admins can submit display-name updates.
    - Verify non-admin roles see the data but cannot edit it if the route is later opened to them.

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
