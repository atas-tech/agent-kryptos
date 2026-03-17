# Phase 3E: Hosted Hardening, Ecosystem & Launch

Phase 3E picks up after the core operator dashboard and admin workflows are in place. This phase hardens the hosted product for broader use, adds the ecosystem and documentation work needed for adoption, and closes with the actual hosted go-live path.

It also absorbs the first hosted policy-management slice that was intentionally left out of Phase 3B: workspace-admin-managed secret registry and exchange policy configuration. In hosted mode, these policy documents must become tenant-scoped workspace state, not process-global environment variables.

This phase is intentionally separate from:

- **Phase 3B**: core operator dashboard and admin UX
- **Phase 3C**: paid guest requester flows
- **Phase 3D**: autonomous payments and crypto billing

**Prerequisites**:

- Phase 3A hosted platform is complete
- Phase 3B operator dashboard and recurring billing admin UX are complete
- Hosted APIs are stable enough to publish SDKs and onboarding docs

**Development strategy**: local-first for analytics and abuse controls, then ecosystem packaging and documentation, with production deployment and domain cutover left for the final milestone.

> [!IMPORTANT]
> This plan is divided into **3 incremental milestones**. The order is: Analytics, Workspace Policy Management & Abuse Controls → SDKs, Docs & Community → Hosted Deployment & Domain Cutover.

## Milestone 1: Analytics, Workspace Policy Management & Advanced Abuse Controls

Add workspace-level operational metrics, make hosted policy tenant-scoped and admin-manageable, and strengthen signup/auth abuse protections with advanced abuse controls.

### Analytics Page (`/analytics`)

Metadata-minimized, zero-knowledge-preserving workspace metrics:

- **Request volume**: daily secret request count over last 30 days
- **Exchange metrics**: successful vs. failed/expired/denied exchanges over last 30 days
- **Active agents**: count of agents that minted a JWT in the last 24 hours

### [NEW] `packages/sps-server/src/services/analytics.ts`

Backend aggregate queries over the `audit_log` table, scoped by `workspace_id`:

- `getRequestVolume(workspaceId, days)` → daily counts of `request_created` events
- `getExchangeMetrics(workspaceId, days)` → daily counts grouped by terminal status
- `getActiveAgentCount(workspaceId, hours)` → distinct `actor_id` where `actor_type = 'agent'`

All queries return counts and timestamps only. They never expose secret names, ciphertext, token values, or per-agent identifiers beyond aggregate counts.

### [NEW] `packages/sps-server/src/routes/analytics.ts`

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /api/v2/analytics/requests` | User JWT (admin/operator) | Daily request volume for last N days |
| `GET /api/v2/analytics/exchanges` | User JWT (admin/operator) | Daily exchange outcome metrics |
| `GET /api/v2/analytics/agents` | User JWT (admin/operator) | Active agent count |

RBAC: `workspace_viewer` cannot access analytics in the MVP.

### Workspace Policy Management

Move Agent-to-Agent policy off the app-wide `SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` singleton path for hosted workspaces.

Hosted policy source of truth:

- `workspace_admin` manages a workspace-scoped secret registry and exchange policy document
- policy is stored in PostgreSQL and versioned per workspace
- SPS resolves and caches compiled policy by `workspace_id`
- environment variables remain valid only as self-hosted bootstrap/default configuration, not as the hosted per-workspace control plane

### [NEW] `packages/sps-server/src/services/workspace-policy.ts`

Workspace-scoped policy persistence and validation:

- store `secret_registry_json`, `exchange_policy_json`, `version`, `updated_by_user_id`, `created_at`, `updated_at`
- validate that every policy rule references a declared `secretName`
- reject duplicate `ruleId` values within a workspace
- limit list sizes and field lengths to avoid pathological policy payloads
- compile and cache an `ExchangePolicyEngine` per `(workspace_id, version)`

### [NEW] `packages/sps-server/src/routes/workspace-policy.ts`

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /api/v2/workspace/policy` | User JWT (admin/operator) | Return the current workspace policy document and metadata |
| `PATCH /api/v2/workspace/policy` | User JWT (admin) | Replace the workspace policy document after validation and optimistic concurrency checks |
| `POST /api/v2/workspace/policy/validate` | User JWT (admin) | Validate a draft policy without persisting it |

Admin-editable policy fields are limited to business-policy inputs:

- secret registry entries: `secretName`, `classification`, `description`
- exchange rules: `ruleId`, `secretName`, requester/fulfiller identities or rings, `purposes`, `mode`, `reason`, same-ring constraints

Fields that remain platform-controlled and must not be workspace-admin-editable:

- `workspace_id`, approval references, policy hashes, fulfillment reservations, and other runtime-generated state
- workload identity trust settings such as issuer, audience, JWKS, or SPIFFE requirements
- cross-workspace tenancy rules
- TTL, quota, rate-limit, billing, cryptography, and audit-retention controls

### Platform Global Emergency Overrides

Hosted mode should keep a separate **platform global policy** layer for emergency restriction and coordinated-response cases. This layer is outside tenant-editable workspace policy and is maintained only by platform operators.

Rules for this layer:

- it may only **restrict** or revoke behavior, never grant access
- it applies before or alongside workspace policy evaluation
- it can target compromised agent ids, abusive requester identities, payment rails, offer classes, or workspaces under active abuse review
- it must be fully audited and versioned

For paid guest intents and other settled flows, the normal workspace policy snapshot remains authoritative after payment or approval. Platform global overrides are the narrow exception that may still block execution after settlement.

### Advanced Abuse Controls

Strengthen protections beyond Phase 3A's per-IP rate limiting.

#### [MODIFY] Frontend: Cloudflare Turnstile Integration

- Add Turnstile challenge widget to `Register.tsx` and `Login.tsx`
- Dashboard sends the Turnstile response token with auth requests
- Backend validates the token server-side via Turnstile `/siteverify` before processing registration/login

#### [MODIFY] `packages/sps-server/src/routes/auth.ts`

- Add optional `cf_turnstile_response` field to register/login request bodies
- When `SPS_TURNSTILE_SECRET` is set, validate the token before auth processing
- When it is not set, skip challenge verification for local/dev

#### [MODIFY] `packages/sps-server/src/middleware/rate-limit.ts`

- Add anomaly burst detection: if a single workspace exceeds 5x its tier quota within a sliding hour window, emit an `abuse_alert` audit event and temporarily throttle to 1 req/min for that workspace
- Workspace-level throttle is self-clearing after the hour window passes

**Acceptance**: Analytics page renders business-event charts for request volume, exchange outcomes, and active agents. Workspace admins can manage tenant-scoped secret registry and exchange policy documents without editing server env vars. Policy edits are workspace-scoped, validated, audited, and re-evaluated on later exchange lifecycle steps. Turnstile blocks automated signup in hosted mode. Burst anomaly detection throttles and logs abuse attempts.

---

## Milestone 2: SDKs, Documentation & Community

Make the platform accessible to developers who are not reading source code directly.

### Language SDKs

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

### Documentation

| Document | Location | Content |
|----------|----------|---------|
| API Reference | `docs/api/` | OpenAPI 3.0 spec for all SPS routes, auto-generated from route schemas where possible |
| Quick Start | `docs/guides/quickstart.md` | 5-minute guide: register workspace → enroll agent → deliver first secret |
| Identity Bootstrap | `docs/guides/identity.md` | How to get an `ak_` key, mint JWTs, configure agent-skill |
| Policy Configuration | `docs/guides/policy.md` | Hosted workspace policy editor model, trust rings, secret registry, exchange policies, approval workflows, and self-hosted env bootstrap/default behavior |
| Self-Hosting | `docs/guides/self-hosting.md` | Docker Compose guide with env var reference and reverse proxy setup |

### Docker Compose Community Guide

Sanitize and publish the production Docker Compose setup:

- Remove operator-specific details
- Add `.env.example` with all required variables and sensible defaults
- Add `Makefile` with `make up`, `make down`, `make logs`, `make migrate` targets
- Include clear README with prerequisites (Docker, domain, DNS)

**Acceptance**: Node.js SDK publishes to npm. Python and Go SDKs install and complete the bootstrap → secret delivery flow against a running SPS instance. API documentation covers all hosted routes through Phase 3E, including workspace policy-management routes and guidance. Docker Compose community guide brings up a working stack from scratch.

---

## Milestone 3: Hosted Deployment & Domain Cutover

Stand up the production deployment with proper domains and TLS. This is the final hosted-launch milestone.

### Deployment Architecture

| Subdomain | Service | Container |
|-----------|---------|-----------|
| `sps.atas.tech` | SPS API | `ghcr.io/tuthan/agent-kryptos-sps-server` |
| `secret.atas.tech` | Browser UI (zero-knowledge sandbox) | `ghcr.io/tuthan/agent-kryptos-browser-ui` |
| `app.atas.tech` | Operator Dashboard | `ghcr.io/tuthan/agent-kryptos-dashboard` |

Reverse proxy and TLS are handled by the operator's existing Unraid reverse proxy (for example Nginx Proxy Manager or Traefik). No bundled reverse proxy is included.

### [NEW] `packages/sps-server/src/routes/health.ts`

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `GET /healthz` | None | Returns `200` if server is up |
| `GET /readyz` | None | Returns `200` if PostgreSQL + Redis are reachable; `503` otherwise |

Health checks are used by Docker `HEALTHCHECK` and by the reverse proxy for upstream readiness.

### [MODIFY] `.github/workflows/build-and-push-images.yml`

- Add `dashboard` image build target (`ghcr.io/tuthan/agent-kryptos-dashboard`)
- Pin `VITE_SPS_API_URL=https://sps.atas.tech` for production browser-ui and dashboard builds

### [MODIFY] `docs/deployment/Unraid.md`

- Add dashboard container template reference
- Update domain examples to `sps.atas.tech`, `secret.atas.tech`, `app.atas.tech`
- Document reverse proxy configuration for the three domains
- Add `SPS_HOSTED_MODE`, `SPS_TURNSTILE_SECRET`, and other Phase 3E env vars
- Clarify that `SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` are self-hosted bootstrap/default inputs, not the hosted per-workspace configuration path

### [NEW] `deploy/unraid/agent-kryptos-dashboard.xml`

Unraid Docker template for the dashboard SPA container.

### DNS Setup

Create A or CNAME records for `sps.atas.tech`, `secret.atas.tech`, and `app.atas.tech` pointing to the Unraid host. TLS is managed by the operator's reverse proxy.

### Gateway Allowlist Update

Update the SPS egress URL filter allowlist to match the production domains:

- Secret input sandbox: `https://secret.atas.tech/*`
- Dashboard: `https://app.atas.tech/*` if links are ever sent in chat

**Acceptance**: All three subdomains serve over HTTPS with valid TLS. Health checks pass. Existing SPS operations work at the new URLs. Dashboard login/registration completes successfully against the production API. Gateway egress URL allowlist is verified.

---

## Infrastructure Changes

### Container Images

| Image | Source | Notes |
|-------|--------|-------|
| `ghcr.io/tuthan/agent-kryptos-sps-server` | Existing | Add health check endpoints + analytics routes |
| `ghcr.io/tuthan/agent-kryptos-browser-ui` | Existing | Rebuild with production `VITE_SPS_API_URL` |
| `ghcr.io/tuthan/agent-kryptos-dashboard` | New | Vite build, served via lightweight static server |
| `postgres:16-alpine` | Upstream | Production credentials via env |
| `redis:7-alpine` | Upstream | Unchanged |

### New Environment Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `SPS_TURNSTILE_SECRET` | sps-server | Cloudflare Turnstile server-side validation key |
| `VITE_TURNSTILE_SITE_KEY` | dashboard | Turnstile widget site key baked into the build |
| `BILLING_PORTAL_RETURN_URL` | sps-server | URL to redirect after billing portal session (default: `https://app.atas.tech/billing`) |
| `VITE_SPS_API_URL` | dashboard, browser-ui | SPS API base URL baked at build time |

`SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` remain supported for self-hosted installations, but in hosted Phase 3E they are treated as bootstrap/default configuration rather than the long-term source of truth for individual workspaces.

---

## Verification Plan

Detailed E2E and integration scenarios for this phase live in `docs/testing/Phase 3E.md`.

### Automated Tests

All tests use **Vitest**. Run from project root:

```bash
npm test
npm test --workspace=packages/sps-server
npm test --workspace=packages/dashboard
```

#### Milestone 1: `analytics.test.ts`, `workspace-policy.test.ts`, and hosted auth/rate-limit coverage

- `getRequestVolume` returns correct daily counts from `audit_log`
- `getExchangeMetrics` groups by terminal status correctly
- `getActiveAgentCount` counts distinct actors within the time window
- Analytics endpoints return only caller-workspace data
- `GET /api/v2/workspace/policy` returns only caller-workspace policy documents
- `PATCH /api/v2/workspace/policy` is admin-only, validates drafts, increments version, and records audit events
- policy changes invalidate stale exchange decisions on later fulfill/submit paths without affecting other workspaces
- Turnstile validation rejects invalid tokens when configured
- Burst anomaly detection triggers workspace throttle after 5x quota

#### Milestone 2: SDK integration and documentation validation

- Node.js SDK bootstrap → request secret → retrieve flow succeeds
- Python SDK succeeds with the same hosted bootstrap and delivery flow
- Go SDK succeeds with the same hosted bootstrap and delivery flow
- OpenAPI spec validates against running server responses

#### Milestone 3: `health.test.ts` and deployment checks

- `GET /healthz` returns `200`
- `GET /readyz` returns `200` when PostgreSQL and Redis are reachable
- `GET /readyz` returns `503` when PostgreSQL or Redis is unavailable
- Production image builds pass CI
- All three subdomains resolve and serve with valid TLS

### Manual Verification

1. **Analytics**: generate traffic over several days and verify charts render on the analytics page.
2. **Workspace policy**: as a workspace admin, create a secret registry entry and approval-gated exchange rule in the dashboard, then verify the next matching exchange request moves to `pending_approval` without editing server env vars.
3. **Abuse controls**: attempt rapid-fire signups and verify Turnstile appears; trigger a burst and verify throttle + `abuse_alert`.
4. **SDK quickstart**: follow the quickstart guide from a clean machine and verify first secret delivery succeeds.
5. **Production**: deploy all containers to Unraid and complete a full register → enroll agent → deliver secret flow at production URLs.

---

## Resolved Decisions

- **Turnstile** → Cloudflare Turnstile for signup/login challenge, gated by env var so local/dev can skip it
- **Analytics scope** → business-event counts and timestamps only; no secret names, ciphertext, token values, specific agent identifiers, or HTTP response-class telemetry
- **Hosted policy source of truth** → workspace-scoped PostgreSQL policy documents in hosted mode; `SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` remain self-hosted bootstrap/default inputs
- **Global governance** → platform operators keep a separate emergency-restriction layer above workspace policy; it may deny or revoke globally, but never grant access
- **SDK priority** → Node.js first, then Python, then Go
- **API documentation** → OpenAPI 3.0 spec; hand-written initially, auto-generation deferred
- **Reverse proxy** → operator-managed; no bundled reverse proxy
- **Domain strategy** → `app.atas.tech` for dashboard, `secret.atas.tech` for sandbox, `sps.atas.tech` for API
- **Launch ordering** → local hardening and ecosystem work land before production cutover

### Suggested Work Breakdown

1. Analytics backend + workspace policy management + dashboard policy UI + Turnstile + burst detection
2. Node.js SDK publish + Python SDK + Go SDK + docs + community guide
3. Hosted deployment + domain cutover + health checks
