# Phase 3B: UI Dashboard, Operations, SDKs & Community

Phase 3B transitions the focus from building the underlying backend SaaS primitives (completed in Phase 3A) to operationalizing the platform. This phase introduces the persistent human-facing Operator Dashboard, hardens public endpoints against abuse, and improves the onboarding experience for both humans and agents.

**Prerequisite**: All 6 Phase 3A milestones are complete — PostgreSQL-backed workspaces, human auth, workspace-scoped SPS, agent enrollment, Stripe billing, rate limiting, and durable audit are all in place.

**Development strategy**: Local-first. All dashboard and backend work is developed and tested locally before any production deployment. Hosted deployment and domain cutover come last.

**Frontend stack**: The Operator Dashboard is a new `packages/dashboard` package using **Vite + React** (TypeScript). The existing `packages/browser-ui` (vanilla JS zero-knowledge sandbox) remains a separate, isolated package — it must never share runtime code or session state with the dashboard.

**Design workflow**: Dashboard screens are designed first using **Stitch** (via MCP), then implemented by extracting HTML/CSS from the generated designs and adapting them into React components. **Crucially, while Stitch provides the layout and UX patterns, all implementations must override colors and gradients to stay 100% consistent with the Kryptos Design System (Deep Navy, Cyan/Purple gradients).**

**Theming & Color Consistency**: To maintain visual identity, all dashboard components must exclusively use the CSS variables defined in `src/styles/index.css`. Ad-hoc color utilities or hardcoded hex values from Stitch exports must be replaced with theme variables (e.g., `--bg`, `--primary`, `--purple`) to ensure any future system-wide theme changes (like a Light Mode) can be applied automatically.

> [!IMPORTANT]
> This plan is divided into **8 incremental milestones**, each independently deployable. The order is: UI Design (Stitch) → Dashboard Shell & Auth → Agent & Member Management → Audit & Approvals → Billing & Quotas → Analytics & Abuse Controls → SDKs, Docs & Community → Hosted Deployment.

## Progress

- `2026-03-12`: Milestone 1 complete — All 14 dashboard screens designed in Stitch (Project ID: `5937100388262572555`). Ready for implementation.
- `2026-03-13`: Milestone 2 frontend implementation landed in `packages/dashboard` using Stitch HTML exports as the layout reference. Auth flows, refresh persistence, force-password-change routing, role-aware sidebar navigation, and responsive placeholder routes for the full shell are now in place. Later CRUD pages remain scaffolded until Milestones 3-6 wire their APIs.
- `2026-03-13`: Milestone 3 complete — Agent & Member management landed. CRUD interfaces for agents and members are fully operational with paginated backend support and enforced last-admin lockout. E2E and component verification complete.
- `2026-03-13`: Milestone 4 complete — Audit Log Viewer and Approvals Inbox landed. Paginated audit log with filtering, exchange lifecycle drill-down, and A2A approval inbox are fully operational and verified. Data leak scanning confirms no sensitive keys exist in audit metadata.

---

## Proposed Changes

### New Project Structure Additions

```
packages/dashboard/                       # [NEW] Operator Dashboard SPA
  package.json
  vite.config.ts
  tsconfig.json
  tailwind.config.ts
  postcss.config.js
  index.html
  src/
    main.tsx                              # React entry point
    App.tsx                               # Root component + router
    api/
      client.ts                           # Typed fetch wrapper for SPS API (base URL, auth headers, refresh interceptor)
    auth/
      AuthContext.tsx                      # React context for session state (user, workspace, tokens)
      useAuth.ts                          # Hook: login, logout, refresh, isAuthenticated
      ProtectedRoute.tsx                  # Route guard: redirect to /login if unauthenticated, block if fpc=true, enforce allowed roles
    pages/
      Login.tsx                           # Email + password login
      Register.tsx                        # Signup: email, password, workspace slug, display name
      ForgotPassword.tsx                  # Placeholder — wired when SMTP lands
      ChangePassword.tsx                  # Force-change on first login when fpc=true
      Dashboard.tsx                       # Admin-only home: workspace overview, quota summary, quick actions
      Agents.tsx                          # List agents, enroll new, rotate key, revoke
      Members.tsx                         # List users, create with temp password, change role
      Audit.tsx                           # Paginated audit log viewer with filters
      Approvals.tsx                       # Pending A2A approval inbox
      Billing.tsx                         # Current tier, quota meters, Stripe portal link
      Analytics.tsx                       # Workspace metrics (Milestone 6)
      Settings.tsx                        # Workspace display name, slug (read-only in MVP)
    components/
      Layout.tsx                          # App shell: role-aware sidebar nav, header, content area
      ApiKeyReveal.tsx                    # One-time display of ak_ key with copy button
      QuotaMeter.tsx                      # Visual gauge for daily usage vs limit
      DataTable.tsx                       # Reusable sortable/filterable table
      StatusBadge.tsx                     # Colored badge for agent/exchange/subscription status
      EmptyState.tsx                      # Friendly zero-state illustrations
      ConfirmDialog.tsx                   # Destructive action confirmation modal
    styles/
      index.css                           # Tailwind layers + design tokens + global styles
      theme.ts                            # Dark/light theme config
    hooks/
      usePagination.ts                    # Cursor pagination for audit, agents, members
      useQuota.ts                         # Fetch + cache workspace quota state

deploy/
  unraid/
    agent-kryptos-dashboard.xml           # [NEW] Unraid template for dashboard container

packages/sps-server/src/
  routes/
    health.ts                             # [NEW] Health/readiness endpoints
    dashboard.ts                          # [NEW] Dashboard summary endpoint
    analytics.ts                          # [NEW] Workspace metrics endpoints
  services/
    dashboard.ts                          # [NEW] Workspace overview + quota summary aggregation
    analytics.ts                          # [NEW] Workspace aggregate metrics
```

---

### Milestone 1: Dashboard UI Design (Stitch)

Design all dashboard screens using **Stitch via MCP** before writing any React code. This creates a visual contract to implement against and avoids designing in code.

#### Screens to Design

| Screen | Description | Key Elements |
|--------|------------|--------------|
| **Login** | Email + password form | Branded header, form fields, "Register" link, Turnstile placeholder |
| **Register** | Signup form | Email, password, workspace slug, display name fields, validation hints |
| **Change Password** | Force-change on first login | Current password, new password, confirm, guidance text |
| **Dashboard Home** | Admin-only workspace overview | Quota meters (requests, agents, members), quick action cards, workspace name/tier badge |
| **Agents** | Agent management | Data table with Status badge, "Enroll Agent" button, row actions (rotate/revoke) |
| **Agent Enroll Modal** | Bootstrap key reveal | Agent ID input, generated `ak_` key display with copy button, "I've saved this" checkbox |
| **Members** | Member management | Data table, "Add Member" button, role dropdown per row, last-admin lockout indicator |
| **Audit Log** | Event stream | Filter bar (event type, actor, date range), paginated data table, row expansion for metadata |
| **Exchange Timeline** | Drill-down from audit | Vertical timeline of lifecycle events with approval history interleaved |
| **Approvals Inbox** | Pending A2A approvals | Approval cards with agent details, purpose, Approve/Deny action buttons |
| **Billing** | Subscription management | Current tier card, feature comparison, upgrade CTA / Stripe portal link |
| **Analytics** | Workspace metrics | Request volume bar chart, exchange outcome chart, active agents counter, error rate trend |
| **Settings** | Workspace configuration | Display name edit, slug (read-only), owner verification status |
| **App Shell / Layout** | Sidebar + header | Navigation sidebar, workspace name, user dropdown, responsive collapse |

#### Design Process

1. Create a Stitch project for the dashboard
2. Design each screen with realistic sample data (not placeholder text)
3. Use a consistent dark-mode-first aesthetic (Kryptos Design System): deep navy backgrounds (`#060a14`), cyan/purple gradients (`#00f5d4` to `#7b61ff`), glassmorphism cards, Inter typography
4. Review and iterate on designs before implementation, ensuring they match existing authenticated screens.
5. Export finalized HTML/CSS from Stitch as the implementation reference, mapping all color hexes back to the `--primary`, `--bg`, and `--purple` CSS variables.

#### Design Constraints

- **Dark-mode-first** with optional light mode toggle later
- **Typography**: Inter (Google Fonts), system-ui fallback
- **Color palette**: MUST use shared tokens from `index.css`:
    - Background: `--bg` (#060a14)
    - Primary: `--primary` (#00f5d4, Cyan)
    - Accent: `--purple` (#7b61ff)
    - Gradients: `linear-gradient(135deg, var(--primary) 0%, var(--primary-strong) 50%, var(--purple) 100%)`
- **Components**: Glassmorphism cards with `backdrop-filter`, smooth `200ms` hover transitions, subtle micro-animations on state changes
- **Spacing**: 4px base grid, consistent border-radius tokens (`4px`, `8px`, `12px`)
- **Responsive**: Collapsible sidebar below 768px breakpoint
- **Brand**: "agent-Kryptos" branding consistent with `kryptos.atas.tech` landing page. Layouts follow Stitch, but aesthetics follow the Kryptos Brand.

**Acceptance**: All 14 screens designed in Stitch. Visual design reviewed and approved before Milestone 2 begins.

---

### Milestone 2: Dashboard Shell & Authentication UI

Bootstrap the React dashboard and implement auth flows. Adapt HTML/CSS from the Stitch designs in Milestone 1 into React components.

#### [NEW] `packages/dashboard` package

Initialize with Vite + React + TypeScript:

```bash
npx -y create-vite@latest ./ --template react-ts
```

Key dependencies: `react-router-dom` (routing) and Tailwind CSS for adapting Stitch output into reusable React components while keeping shared design tokens in `styles/index.css`.

#### Core Architecture

- **`api/client.ts`**: Typed fetch wrapper. In local dev, configured with `VITE_SPS_API_URL` (default `http://localhost:3100`). Automatically attaches `Authorization: Bearer <accessToken>` from `AuthContext`. Implements a 401-interceptor that attempts a single `POST /api/v2/auth/refresh` before redirecting to `/login`.
- **`auth/AuthContext.tsx`**: Stores `{ user, workspace, accessToken, refreshToken }` in React context. Persists refresh token in `localStorage` (access token in memory only). Exposes `login()`, `logout()`, `refresh()`, `isAuthenticated`.
- **`auth/ProtectedRoute.tsx`**: Wraps routes that require auth. Redirects to `/login` if unauthenticated, to `/change-password` if `fpc === true` in the access token claims, and to the caller's first allowed route when role-gated pages are not permitted.
- **`components/Layout.tsx`**: App shell adapted from Stitch design with role-aware sidebar navigation. `workspace_admin` sees Dashboard, Agents, Members, Audit, Approvals, Billing, Analytics, Settings; `workspace_operator` lands on Agents; `workspace_viewer` lands on Audit.

#### Auth Pages

| Page | Route | Consumes API |
|------|-------|-------------|
| `Login.tsx` | `/login` | `POST /api/v2/auth/login` |
| `Register.tsx` | `/register` | `POST /api/v2/auth/register` |
| `ChangePassword.tsx` | `/change-password` | `POST /api/v2/auth/change-password` |
| `ForgotPassword.tsx` | `/forgot-password` | Placeholder — shows "contact admin" until SMTP lands |

#### Design Adaptation Process

1. Extract HTML structure and CSS from Stitch-generated screens
2. Decompose into React components following the project structure
3. Replace static values with React state / props
4. Wire up API calls to the SPS backend
5. Verify visual fidelity against the Stitch designs

**Acceptance**: User can run `npm run dev --workspace=packages/dashboard`, navigate to `localhost:5173`, register a new workspace, log in, see the dashboard shell with role-aware sidebar nav, log out, and refresh the page without losing the session. Force-password-change redirect works for admin-created users, and non-admin roles are redirected to their first allowed route. Visual output matches Stitch designs.

---

### Milestone 3: Agent & Member Management UI

Build the CRUD interfaces for the two most common workspace admin tasks.

#### Milestone 3 execution plan

This milestone should be implemented as a thin vertical slice over the Phase 3A APIs that already exist, not as a dashboard-only mock layer. The backend already ships the write paths for agents, members, and workspace display name updates:

- `POST /api/v2/agents`
- `POST /api/v2/agents/:aid/rotate-key`
- `DELETE /api/v2/agents/:aid`
- `POST /api/v2/members`
- `PATCH /api/v2/members/:uid`
- `GET /api/v2/workspace`
- `PATCH /api/v2/workspace`

The main backend gaps for Milestone 3 are the paginated read contracts and one settings-read field for the owner verification indicator.

#### Stitch adaptation map

Milestone 3 must continue the same design workflow used in Milestone 2: extract layout structure from Stitch, then adapt it into React components while replacing exported color values with dashboard theme variables from `packages/dashboard/src/styles/index.css`.

- Primary desktop references:
  - `Desktop Agents Management`
  - `Enroll Agent Modal Screen`
  - `Desktop Members Management`
  - `Desktop Workspace Settings Overview`
- Mobile parity references:
  - `agent-Kryptos Agents Management`
  - `Enroll Agent Modal Screen`
  - `agent-Kryptos Members Management`
  - `Workspace Settings Overview`
- Rule: keep Stitch spacing, panel hierarchy, modal composition, and responsive breakpoints; do not copy raw Stitch hex colors or one-off gradients into the React code.

#### Recommended implementation order

1. **Finalize read-model contracts in `sps-server`**
   - Extend `GET /api/v2/agents` to accept `limit`, `cursor`, and optional `status`, returning `{ agents, next_cursor }`
   - Extend `GET /api/v2/members` to accept `limit`, `cursor`, and optional `status`, returning `{ members, next_cursor }`
   - Add owner verification status to the workspace read contract used by `/settings`
   - Keep ordering stable and cursor-safe: use `created_at` plus a deterministic tie-breaker such as `id`

2. **Add dashboard primitives before page wiring**
   - Implement reusable `StatusBadge`, `DataTable`, `ConfirmDialog`, `EmptyState`, and `ApiKeyReveal`
   - Add a small cursor-pagination hook instead of duplicating fetch/append state in each page
   - Add a temporary-password strength indicator for the member create form

3. **Implement `/agents` from the Stitch management + modal screens**
   - Replace the placeholder page with a live list view, status badges, and row actions
   - Wire enroll and rotate flows to the one-time `ApiKeyReveal` modal
   - Keep the revealed `ak_` key only in transient component state; never persist it to storage, URL params, or logs
   - Allow operators and admins to access this page; viewers remain blocked by route guards and backend RBAC

4. **Implement `/members` from the Stitch member-management screen**
   - Replace the placeholder with a paginated member table
   - Wire add-member modal/form, inline role updates, and suspend actions
   - Mirror backend last-admin protection in the UI by disabling demote/suspend controls when only one active admin remains
   - Preserve the backend as the final authority: UI disablement is advisory, API rejection remains mandatory

5. **Implement `/settings` from the Stitch settings screen**
   - Replace the placeholder with a read-mostly workspace settings page
   - Show slug and tier as read-only
   - Allow admin-only inline edit of display name
   - Surface owner email verification as an explicit status indicator so admin/operator confusion is avoided

6. **Land tests with each slice**
   - `packages/sps-server`: pagination, filtering, RBAC, and last-admin lockout regression coverage
   - `packages/dashboard`: component tests for reveal modal, member controls, pagination append behavior, and settings edit state
   - End-to-end: admin and operator happy paths plus viewer denial paths

#### Agent Enrollment Page (`/agents`)

- **Agent list table**: columns — Agent ID, Display Name, Status (active/revoked), Created At, Actions
- **"Enroll Agent" flow**: form with `agent_id` + optional `display_name` → calls `POST /api/v2/agents` → on success, renders `ApiKeyReveal` component showing the `ak_...` key **once** with a copy-to-clipboard button and a "I've saved this key" confirmation checkbox that dismisses the modal
- **Rotate Key**: confirmation dialog → `POST /api/v2/agents/:aid/rotate-key` → shows new key via `ApiKeyReveal`
- **Revoke Agent**: `ConfirmDialog` → `DELETE /api/v2/agents/:aid`
- RBAC: only `workspace_admin` and `workspace_operator` roles see this page

#### Member Management Page (`/members`)

- **Member list table**: columns — Email, Role, Status, Created At, Actions
- **"Add Member" flow**: form with email + role selector + temporary password input (min 12 chars, with strength indicator) → `POST /api/v2/members`
- **Change Role**: inline dropdown → `PATCH /api/v2/members/:uid`
- **Suspend Member**: `ConfirmDialog` → `PATCH /api/v2/members/:uid` with `status: suspended`
- Last-admin warning: disable demotion/suspension controls when only one active admin remains
- RBAC: only `workspace_admin` sees this page

#### Workspace Settings Page (`/settings`)

- Read-only display of workspace slug, display name, tier
- `workspace_admin` can edit display name via `PATCH /api/v2/workspace`
- Owner email verification status indicator

#### [MODIFY] Backend list endpoints for dashboard pagination

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /api/v2/agents` | User JWT (admin/operator) | Add `limit`, `cursor`, optional `status`; return paginated agent rows plus `next_cursor` |
| `GET /api/v2/members` | User JWT (admin) | Add `limit`, `cursor`, optional `status`; return paginated member rows plus `next_cursor` |
| `GET /api/v2/workspace` | User JWT (admin/operator/viewer) | Include owner verification status so `/settings` can render the verification badge without client-side guesswork |

**Acceptance**: Workspace admin can enroll an agent and see the bootstrap key exactly once, rotate keys, revoke agents, and page through the agent list. Admin can create workspace members with temporary passwords, manage roles, and page through the member list. Last-admin lockout protection is visually enforced.

---

### Milestone 4: Audit Log Viewer & Approvals Inbox

Surface the existing Phase 3A audit and approval endpoints in the dashboard.

#### Audit Log Page (`/audit`)

- **`DataTable`** bound to `GET /api/v2/audit` with backend pagination
- **Filter bar**: event type dropdown, actor type (user/agent/system), resource ID text input, date range picker
- **Row expansion**: click a row to see full metadata JSON (sanitized — no ciphertext, no tokens)
- **Exchange drill-down**: click an exchange-related event → navigate to exchange detail view calling `GET /api/v2/audit/exchange/:id`, showing the full lifecycle timeline (requested → reserved → submitted → retrieved) with approval history interleaved
- RBAC: all roles (`workspace_admin`, `workspace_operator`, `workspace_viewer`) can view audit; viewer is read-only throughout the entire dashboard

#### [MODIFY] Backend: audit pagination contract

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /api/v2/audit` | User JWT (admin/operator/viewer) | Add `cursor` alongside existing filters and `limit`; return `records` plus `next_cursor` |

#### Approvals Inbox Page (`/approvals`)

- Displays pending A2A exchange approval requests for the current workspace
- Each pending approval card shows: requester agent, fulfiller agent, secret name, purpose, requested at, policy rule that triggered approval
- **Approve / Deny** buttons → call existing `POST /api/v2/secret/exchange/admin/approval/:id/approve` or `/reject`
- RBAC: `workspace_admin` and `workspace_operator` can approve/deny; `workspace_viewer` sees the inbox read-only

> [!NOTE]
> The approvals inbox consumes the existing Phase 2B approval endpoints. No new backend routes are needed — only the UI to surface them.

**Acceptance**: All workspace roles can view the audit log with filters and pagination. Exchange lifecycle timeline renders correctly. Admin/operator can approve or deny pending A2A exchanges from the inbox.

---

### Milestone 5: Billing & Quota Dashboard

Give workspace admins visibility into their subscription and usage.

#### Billing Page (`/billing`)

- **Current plan card**: shows Free or Standard tier with feature comparison table
- **Upgrade button** (Free tier only): calls `POST /api/v2/billing/checkout` → redirects to Stripe Checkout
- **Manage subscription link** (Standard tier): opens Stripe Customer Portal using an auto-generated portal session URL
- **Subscription status badge**: active, past_due, canceled, etc.
- RBAC: only `workspace_admin` can access this page in the MVP

#### Quota Usage Section (on Dashboard home page)

- Admin-only. `workspace_operator` and `workspace_viewer` do not land on the home route.
- **`QuotaMeter` components** showing daily usage vs. limits for:
  - Secret requests (10/day free, 1,000/day standard)
  - Enrolled agents (5 free, 50 standard)
  - Workspace members (1 free, 10 standard)
  - A2A exchange availability (❌ free, ✅ standard)
- Gauges use color coding: green (<70%), amber (70-90%), red (>90%)
- Data source: prefer a dedicated admin-only summary endpoint so the home page does not fan out across multiple list endpoints for counts and quota state

#### [NEW] Backend: dashboard summary + Stripe Customer Portal Session

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /api/v2/dashboard/summary` | User JWT (admin) | Return workspace display info, tier, billing status, quota usage, and top-level counts for the home page |
| `POST /api/v2/billing/portal` | User JWT (admin) | Create Stripe Customer Portal session → return URL |

This milestone adds one dashboard read-model endpoint and one billing endpoint. `POST /api/v2/billing/portal` wraps `stripe.billingPortal.sessions.create()` for the workspace's Stripe customer.

**Acceptance**: Free-tier admin sees the upgrade CTA and completes a test Stripe Checkout flow. Standard-tier admin can access the Stripe portal. The admin-only home dashboard renders from `GET /api/v2/dashboard/summary`, and quota meters display accurate counts.

---

### Milestone 6: Analytics & Advanced Abuse Controls

Add workspace-level operational metrics and strengthen signup/auth abuse protections.

#### Analytics Page (`/analytics`)

Metadata-minimized, zero-knowledge-preserving workspace metrics:

- **Request volume**: daily secret request count over last 30 days (bar chart)
- **Exchange metrics**: successful vs. failed/expired/denied exchanges over last 30 days
- **Active agents**: count of agents that minted a JWT in the last 24 hours

#### [NEW] [services/analytics.ts](file:///home/hvo/Projects/agent-kryptos/packages/sps-server/src/services/analytics.ts)

Backend aggregate queries over the `audit_log` table, scoped by `workspace_id`:

- `getRequestVolume(workspaceId, days)` → daily counts of `request_created` events
- `getExchangeMetrics(workspaceId, days)` → daily counts grouped by terminal status
- `getActiveAgentCount(workspaceId, hours)` → distinct `actor_id` where `actor_type = 'agent'`

All queries return counts and timestamps only — never secret names, agent identifiers beyond counts, or ciphertext.
Analytics in Phase 3B is intentionally limited to business-event telemetry sourced from audit events; HTTP response-class metrics and infrastructure telemetry are out of scope.

#### [NEW] [routes/analytics.ts](file:///home/hvo/Projects/agent-kryptos/packages/sps-server/src/routes/analytics.ts)

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /api/v2/analytics/requests` | User JWT (admin/operator) | Daily request volume for last N days |
| `GET /api/v2/analytics/exchanges` | User JWT (admin/operator) | Daily exchange outcome metrics |
| `GET /api/v2/analytics/agents` | User JWT (admin/operator) | Active agent count |

RBAC: `workspace_viewer` cannot access analytics in the MVP — analytics visibility may expand later.

#### Advanced Abuse Controls

Strengthen protections beyond Phase 3A's per-IP rate limiting:

##### [MODIFY] Frontend: Cloudflare Turnstile Integration

- Add Turnstile challenge widget to `Register.tsx` and `Login.tsx` pages
- Dashboard sends the Turnstile response token with the auth request
- Backend validates the token server-side via Turnstile's `/siteverify` API before processing registration/login

##### [MODIFY] [routes/auth.ts](file:///home/hvo/Projects/agent-kryptos/packages/sps-server/src/routes/auth.ts)

- Add optional `cf_turnstile_response` field to register/login request bodies
- When `SPS_TURNSTILE_SECRET` env var is set, validate the token against the Cloudflare Turnstile API before auth processing
- When not set, skip challenge verification (backward compatible for local/dev)

##### [MODIFY] [middleware/rate-limit.ts](file:///home/hvo/Projects/agent-kryptos/packages/sps-server/src/middleware/rate-limit.ts)

- Add anomaly burst detection: if a single workspace exceeds 5× its tier quota within a sliding hour window, emit an `abuse_alert` audit event and temporarily throttle to 1 req/min for that workspace
- Workspace-level throttle is self-clearing after the hour window passes

**Acceptance**: Analytics page renders business-event charts for request volume, exchange outcomes, and active agents. Turnstile challenge blocks automated signup in hosted mode. Burst anomaly detection throttles and logs abuse attempts.

---

### Milestone 7: SDKs, Documentation & Community

Make the platform accessible to developers who aren't reading source code.

#### Language SDKs

Publish officially supported SDK packages that wrap the SPS API. **Node.js first**, then Python and Go.

| SDK | Package Name | Key Capabilities |
|-----|-------------|-----------------|
| **Node.js** | `@agent-kryptos/sdk` | Published from existing `packages/agent-skill` with documentation, types, and npm release |
| **Python** | `agent-kryptos` (PyPI) | HPKE keygen, secret request/retrieve, exchange request/fulfill/retrieve, bootstrap auth |
| **Go** | `github.com/tuthan/agent-kryptos-go` | Same capabilities as Python SDK |

All SDKs must support:
- Bootstrap API key → JWT minting flow
- HPKE key generation and secret decryption
- Human→Agent: `requestSecret()`, `retrieveSecret()`
- Agent→Agent: `requestExchange()`, `fulfillExchange()`, `submitExchange()`, `retrieveExchange()`
- In-memory-only secret storage with explicit zeroing

#### Documentation

| Document | Location | Content |
|----------|----------|---------|
| API Reference | `docs/api/` | OpenAPI 3.0 spec for all SPS routes, auto-generated from route schemas where possible |
| Quick Start | `docs/guides/quickstart.md` | 5-minute guide: register workspace → enroll agent → deliver first secret |
| Identity Bootstrap | `docs/guides/identity.md` | How to get an `ak_` key, mint JWTs, configure agent-skill |
| Policy Configuration | `docs/guides/policy.md` | Trust rings, secret registry, exchange policies, approval workflows |
| Self-Hosting | `docs/guides/self-hosting.md` | Docker Compose guide with env var reference and reverse proxy setup |

#### Docker Compose Community Guide

Sanitize and publish the production Docker Compose setup:

- Remove operator-specific details
- Add `.env.example` with all required variables and sensible defaults
- Add `Makefile` with `make up`, `make down`, `make logs`, `make migrate` targets
- Include clear README with prerequisites (Docker, domain, DNS)

#### [MODIFY] [Brainstorm Secure Secret System.md](file:///home/hvo/Projects/agent-kryptos/docs/architecture/Brainstorm%20Secure%20Secret%20System.md) Roadmap Section

Update the Phase 3B items to reflect the 8-milestone breakdown and mark items as they are completed.

**Acceptance**: Node.js SDK publishes to npm. Python and Go SDKs install and complete the bootstrap → secret delivery flow against a running SPS instance. API documentation covers all Phase 3A + 3B routes. Docker Compose community guide brings up a working stack from scratch.

---

### Milestone 8: Hosted Deployment & Domain Cutover

Stand up the production deployment with proper domains and TLS. All services become reachable at their public URLs. This is the final milestone — all dashboard features are complete and tested locally before going live.

#### Deployment Architecture

| Subdomain | Service | Container |
|-----------|---------|-----------|
| `sps.atas.tech` | SPS API | `ghcr.io/tuthan/agent-kryptos-sps-server` |
| `secret.atas.tech` | Browser UI (zero-knowledge sandbox) | `ghcr.io/tuthan/agent-kryptos-browser-ui` |
| `app.atas.tech` | Operator Dashboard | `ghcr.io/tuthan/agent-kryptos-dashboard` |

Reverse proxy and TLS are handled by the operator's existing Unraid reverse proxy (e.g., Nginx Proxy Manager, Traefik, or whatever is already in use). No bundled reverse proxy is included — this follows the same pattern as the existing Unraid deployment guide.

#### [NEW] [routes/health.ts](file:///home/hvo/Projects/agent-kryptos/packages/sps-server/src/routes/health.ts)

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /healthz` | None | Returns `200` if server is up |
| `GET /readyz` | None | Returns `200` if PostgreSQL + Redis are reachable; `503` otherwise |

Health checks are used by Docker `HEALTHCHECK` and by the reverse proxy for upstream readiness.

#### [MODIFY] [.github/workflows/build-and-push-images.yml](file:///home/hvo/Projects/agent-kryptos/.github/workflows/build-and-push-images.yml)

- Add `dashboard` image build target (`ghcr.io/tuthan/agent-kryptos-dashboard`)
- Pin `VITE_SPS_API_URL=https://sps.atas.tech` for production browser-ui and dashboard builds

#### [MODIFY] [docs/deployment/Unraid.md](file:///home/hvo/Projects/agent-kryptos/docs/deployment/Unraid.md)

- Add Dashboard container template reference
- Update domain examples to `sps.atas.tech`, `secret.atas.tech`, `app.atas.tech`
- Document reverse proxy configuration for the three domains
- Add `SPS_HOSTED_MODE`, `SPS_TURNSTILE_SECRET`, and other Phase 3B env vars

#### [NEW] [deploy/unraid/agent-kryptos-dashboard.xml](file:///home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-dashboard.xml)

Unraid Docker template for the dashboard SPA container.

#### DNS Setup

Create A or CNAME records for `sps.atas.tech`, `secret.atas.tech`, and `app.atas.tech` pointing to the Unraid host. TLS is managed by the operator's reverse proxy (Nginx Proxy Manager with Let's Encrypt, or equivalent).

#### Gateway Allowlist Update

Update the SPS egress URL filter allowlist to match the production domains:
- Secret input sandbox: `https://secret.atas.tech/*`
- Dashboard: `https://app.atas.tech/*` (if links are ever sent in chat)

**Acceptance**: All three subdomains serve over HTTPS with valid TLS. Health checks pass. Existing SPS operations work at the new URLs. Dashboard login/registration flow completes successfully against the production API. Gateway egress URL allowlist is verified.

---

## Infrastructure Changes

#### Container Images

| Image | Source | Notes |
|-------|--------|-------|
| `ghcr.io/tuthan/agent-kryptos-sps-server` | Existing | Add health check endpoints + analytics routes |
| `ghcr.io/tuthan/agent-kryptos-browser-ui` | Existing | Rebuild with production `VITE_SPS_API_URL` |
| `ghcr.io/tuthan/agent-kryptos-dashboard` | New | Vite build, served via lightweight static server |
| `postgres:16-alpine` | Upstream | Production credentials via env |
| `redis:7-alpine` | Upstream | Unchanged |

#### New Environment Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `SPS_TURNSTILE_SECRET` | sps-server | Cloudflare Turnstile server-side validation key |
| `VITE_TURNSTILE_SITE_KEY` | dashboard | Turnstile widget site key (public, baked into build) |
| `STRIPE_PORTAL_RETURN_URL` | sps-server | URL to redirect after Stripe portal session (default: `https://app.atas.tech/billing`) |
| `VITE_SPS_API_URL` | dashboard, browser-ui | SPS API base URL (baked at build time) |

---

## Verification Plan

Detailed E2E and integration scenarios for this phase live in `docs/testing/Phase 3B.md`.

### Automated Tests

All tests use **Vitest**. Run from project root:

```bash
npm test
npm test --workspace=packages/sps-server
npm test --workspace=packages/dashboard
```

#### Milestone 1: Manual visual review
- Stitch designs reviewed for consistency, completeness, and brand alignment
- All 14 screens approved before Milestone 2

#### Milestone 2: `dashboard` component tests
- `AuthContext` stores token on login and clears on logout
- `ProtectedRoute` redirects unauthenticated users to `/login`
- `ProtectedRoute` redirects `fpc=true` users to `/change-password`
- Non-admin users are redirected away from the admin-only home route after login
- Login page submits credentials and stores returned tokens
- Register page creates workspace and redirects to dashboard
- API client attaches auth header and retries on 401

#### Milestone 3: `dashboard` component tests
- Agent enrollment flow renders `ApiKeyReveal` on success
- `ApiKeyReveal` copy-to-clipboard works and dismisses on confirmation
- Last-admin lockout disables demotion controls correctly
- Member creation enforces minimum 12-character temporary password
- Paginated agent/member table fetches append rows correctly from `next_cursor`

#### Milestone 4: `dashboard` component tests
- Audit table renders paginated results with correct filters
- Exchange timeline renders lifecycle events in chronological order
- Approve/Deny buttons call correct API endpoints
- `workspace_viewer` sees approve/deny buttons as disabled

#### Milestone 5: `billing-portal.test.ts` (sps-server)
- `GET /api/v2/dashboard/summary` returns admin-only workspace overview and quota state
- `POST /api/v2/billing/portal` returns Stripe portal URL for standard-tier workspace
- `POST /api/v2/billing/portal` returns `400` for workspace without Stripe customer
- Quota meter component renders correct percentages and color states

#### Milestone 6: `analytics.test.ts` (sps-server)
- `getRequestVolume` returns correct daily counts from audit_log
- `getExchangeMetrics` groups by terminal status correctly
- `getActiveAgentCount` counts distinct actors within time window
- Analytics endpoints return only caller-workspace data
- Turnstile validation rejects invalid tokens (mocked API)
- Burst anomaly detection triggers workspace throttle after 5× quota

#### Milestone 7: SDK integration tests
- Node.js SDK: bootstrap → request secret → retrieve flow against test SPS
- Python SDK: same flow
- Go SDK: same flow
- OpenAPI spec validates against running server responses

#### Milestone 8: `health.test.ts` (sps-server)
- `GET /healthz` returns `200`
- `GET /readyz` returns `200` when both PostgreSQL and Redis are reachable
- `GET /readyz` returns `503` when PostgreSQL is down (mocked)
- Production image builds pass CI
- All three subdomains resolve and serve with valid TLS

### Manual Verification

1. **Design review** (Milestone 1): Review all Stitch designs in the Stitch project for visual consistency, completeness, and brand alignment
2. **Auth flow** (Milestone 2): Run dashboard locally → Register → redirected to dashboard → see sidebar nav → log out → log back in
3. **Agent enrollment** (Milestone 3): Enroll an agent → see `ak_` key → dismiss → verify key is no longer visible → use key to mint JWT → hit SPS endpoint
4. **Audit viewing** (Milestone 4): Perform several secret requests → open audit page → verify events appear with correct filters → drill into exchange lifecycle
5. **Billing flow** (Milestone 5): Free-tier workspace → click upgrade → complete Stripe test checkout → verify tier badge changes → click "Manage Subscription" → verify Stripe portal opens
6. **Analytics** (Milestone 6): Generate traffic over several days → verify charts render on analytics page → attempt rapid-fire signups → verify Turnstile challenge appears
7. **SDK quickstart** (Milestone 7): Follow the quickstart guide from scratch on a clean machine → verify first secret delivery succeeds
8. **Production** (Milestone 8): Deploy all containers to Unraid → verify all three subdomains serve via HTTPS → complete a full register → enroll agent → deliver secret flow at production URLs

---

## Resolved Decisions

- **Dashboard framework** → Vite + React (TypeScript) in a new `packages/dashboard` package; not merged with `browser-ui`
- **Dashboard CSS** → **Tailwind CSS** is approved for the dashboard to accelerate UI development and component styling.
- **Design workflow** → All screens designed first in Stitch (MCP), then implemented by extracting HTML/Tailwind CSS and adapting into React components
- **Dashboard home** → admin-only. Operators land on Agents; viewers land on Audit.
- **Browser-UI isolation** → `browser-ui` (zero-knowledge sandbox) and `dashboard` (control plane) are separate packages, separate containers, separate domains; they share no runtime code or session state
- **Reverse proxy** → Operator-managed (Nginx Proxy Manager, Traefik, etc. on Unraid); no bundled reverse proxy
- **Turnstile** → Cloudflare Turnstile for signup/login challenge; behind an env-var gate so local/dev skips it
- **Analytics scope** → Business-event counts and timestamps only; never exposes secret names, ciphertext, token values, specific agent identifiers, or HTTP response-class telemetry
- **SDK priority** → Node.js first (existing `agent-skill` code), then Python, then Go
- **API documentation** → OpenAPI 3.0 spec; hand-written initially, auto-generation deferred
- **Domain strategy** → `app.atas.tech` for dashboard, `secret.atas.tech` for sandbox, `sps.atas.tech` for API
- **Stripe portal** → single new backend route (`POST /api/v2/billing/portal`); no other billing backend changes needed
- **Dashboard auth token storage** → refresh token in `localStorage`, access token in memory only; accept the XSS trade-off for MVP simplicity with CSP headers as mitigation. **Note: We must revisit this and evaluate migrating to `httpOnly` cookies before wide / GA go-live.**
- **Force-password-change UX** → dashboard redirects to `/change-password` before allowing any other navigation when `fpc=true`
- **Development order** → local-first; all dashboard features developed and tested locally before any production deployment (Milestone 8 is last)

### Suggested Work Breakdown

1. Design all dashboard screens in Stitch (MCP)
2. Dashboard shell + auth pages adapted from Stitch designs
3. Agent enrollment + member management + settings UI
4. Audit log viewer + exchange timeline + approvals inbox
5. Billing page + quota meters + Stripe portal integration
6. Analytics backend + dashboard charts + Turnstile + burst detection
7. Node.js SDK publish + Python SDK + Go SDK + docs + community guide
8. Hosted deployment + domain cutover + health checks
