# Phase 3E Test Plan: Hosted Hardening, Ecosystem & Launch

This document defines the End-to-End (E2E), integration, and operational verification scenarios for the hosted hardening and launch work split out of Phase 3B.

## How To Run

Phase 3E spans `packages/sps-server`, `packages/dashboard`, SDK packaging work, and deployment artifacts.

1. Start local dependencies:
   `make up`
2. Export the PostgreSQL connection string and enable hosted integration coverage:
   `export DATABASE_URL=postgresql://blindpass:localdev@127.0.0.1:5433/blindpass`
   `export SPS_PG_INTEGRATION=1`
3. Run the server test suites:
   `npm test --workspace=packages/sps-server`
4. Run the dashboard test suites:
   `npm test --workspace=packages/dashboard`

Useful companion commands:

- `make migrate`
- `npm run dev --workspace=packages/sps-server`
- `npm run dev --workspace=packages/dashboard`
- `npm run test:e2e --workspace=packages/sps-server`

## Milestone 1: Dashboard Session Hardening & Advanced Abuse Controls

- [x] **Hosted refresh-session cookie migration**
  - [x] Hosted login and refresh responses set or rotate the refresh token using `Secure` + `httpOnly` cookies
  - [x] Dashboard auth no longer persists the refresh token in `localStorage` or `sessionStorage`
  - [x] Page reload and token refresh still work through the cookie-backed hosted session flow
  - [x] Logout clears the refresh cookie and revokes the backing server-side session
  - [x] Missing or invalid hosted refresh cookies fail closed without silently restoring the session

- [x] **Turnstile**
  - [x] Register/login accepts a valid Turnstile token when configured
  - [x] Register/login rejects an invalid Turnstile token when configured
  - [x] Local/dev mode skips Turnstile validation when the secret is unset

- [x] **Burst throttling**
  - [x] A workspace exceeding the burst threshold emits an `abuse_alert` audit event
  - [x] Throttled workspaces are reduced to 1 request/minute
  - [x] The throttle clears automatically after the window expires
- [x] **Burst Simulator**
  - [x] Trigger a 5x quota burst
  - [x] Verify `abuse_alert` is emitted
  - [x] Verify the throttle applies only to the affected workspace

## Milestone 2: Analytics, SDKs, Documentation & Community

- [x] **Business-event analytics**
  - [x] Analytics API request-volume series reflects `request_created` audit events
  - [x] Analytics API exchange-outcome series groups successful vs failed/expired vs denied terminal business events
  - [x] Analytics API active-agent count reflects distinct recent agent token-mint actors over the configured window
  - [x] Analytics API enforces workspace scoping and blocks `workspace_viewer` access
  - [x] Request volume chart reflects `request_created` audit events
  - [x] Exchange outcome chart reflects requested/submitted/retrieved/denied/rejected business events
  - [x] Active agent count reflects distinct agent actors over the configured window
  - [x] Analytics never exposes secret names, ciphertext, token values, or per-agent identities
 
- [x] **Node.js SDK**
  - [x] Bootstrap API key to JWT minting works against a local hosted SPS
  - [x] Secret request and retrieval flow succeeds end-to-end
  - [x] Exchange request, fulfill, submit, and retrieve flow succeeds end-to-end

- [x] **Analytics E2E**
  - [x] Dashboard metrics reflect workspace activity (Request volume, Active agents)
  - [x] Charts and insight panels render correctly
  - [x] Timeframe selectors trigger data reloads

- [ ] **Python and Go SDKs**
  - [ ] Both SDKs complete the same hosted bootstrap and secret delivery flow
  - [ ] Both SDKs document in-memory-only secret handling expectations

- [x] **Docs and community artifacts**
  - [x] Quickstart guide works from a clean machine
  - [x] OpenAPI references match real route contracts
  - [x] Policy guide explains the hosted workspace policy model and the self-hosted env bootstrap/default path
  - [x] Provide a standard SDK integration harness such as `docker-compose.test.yml` or an equivalent mock container setup

## Milestone 3: Transactional Email With Resend

- [x] **Verification email delivery**
  - [x] Hosted registration sends a verification email through Resend with the correct workspace/app URL
  - [x] Retrying verification invalidates prior verification links so only the newest link succeeds
  - [x] Delivery failures are surfaced as retryable errors without logging raw tokens or provider secrets
  - [x] Local/dev mode still supports a no-provider fallback without blocking local signup flows
  - [x] Verification tokens are stored only as hashes and not in plaintext on the `users` table

- [x] **Forgot-password**
  - [x] Forgot-password request returns the same generic response for existing and unknown email addresses
  - [x] Existing and unknown email paths have comparable observable latency through a minimum-response-duration guard
  - [x] Existing accounts receive a password-reset email through Resend
  - [x] Reset tokens are hashed at rest, expire, are single-use, and live in a shared token table rather than ad hoc user columns
  - [x] Reset completion rotates credentials without reviving revoked or expired reset tokens

- [x] **Abuse controls**
  - [x] `POST /api/v2/auth/forgot-password` enforces dedicated per-IP rate limits
  - [x] `POST /api/v2/auth/retrigger-verification` enforces dedicated per-user or per-IP rate limits
  - [x] Hosted mode can require Turnstile for both email-triggering endpoints
  - [x] These protections work independently of workspace-level burst throttling

- [x] **Dashboard UX**
  - [x] The forgot-password page is no longer a placeholder and completes the request flow
  - [x] Verification resend UI distinguishes successful delivery from backend/provider failure
  - [x] UI messages do not leak account-existence or provider-specific internals

- [x] **Operational coverage**
  - [x] Provider outages or rate limits produce actionable server logs and audit events without exposing recipient-specific secret material
  - [x] Mailer integration tests cover provider success, transient failure, and permanent failure branches
  - [x] Fully automated un-mocked E2E test (`scripts/e2e-real-email.mjs`) verifies end-to-end integration and delivery via Mail.tm


## Milestone 4: Hosted Deployment & Domain Cutover

- [x] `GET /healthz` returns `200`
- [x] `GET /readyz` returns `200` only when PostgreSQL and Redis are reachable
- [x] `GET /readyz` returns `503` if Redis is down but PostgreSQL is up, and vice versa
- [ ] Production dashboard, browser UI, and API images build successfully
- [ ] `app.atas.tech`, `secret.atas.tech`, and `sps.atas.tech` serve over valid HTTPS
- [ ] Hosted register → enroll agent → deliver secret flow succeeds at production URLs
- [ ] Hosted login / refresh / logout work correctly with secure cookie-backed session auth at production URLs
- [ ] No refresh token is readable from JS-accessible browser storage after hosted login
- [ ] A throttled workspace does not impact the performance or rate limits of other active workspaces on the same instance

## Milestone 5: Internationalization (i18n)

- [ ] **Locale JSON parity**
  - [ ] Validation script confirms all English and Vietnamese locale files have identical key structures
  - [ ] Translation review flags untranslated English-copy placeholders in Vietnamese locale files before release

- [ ] **Dashboard i18n**
  - [ ] Dashboard auto-detects Vietnamese when `navigator.language` is `vi`
  - [ ] Registration seeds `preferred_locale` from the current browser-selected locale
  - [ ] Dashboard re-applies `preferred_locale` from auth/login, auth/refresh, and auth/me responses after authentication
  - [ ] Dashboard renders all pages with Vietnamese translations when locale is `vi`
  - [ ] Dashboard renders all pages with English translations when locale is `en`
  - [ ] Language switcher toggles between EN and VI and persists across page reload via `localStorage`
  - [ ] Language switcher persists the authenticated user's locale through `PATCH /api/v2/auth/locale`
  - [ ] No Stitch references, milestone labels, or internal jargon remain in user-facing dashboard text
  - [ ] All `section-label` text uses professional English (no "Desktop Agents Management", "Milestone 3", etc.)

- [ ] **Browser UI i18n**
  - [ ] Browser UI auto-detects Vietnamese when `navigator.language` is `vi`
  - [ ] All static HTML text and JS status messages render in the selected locale
  - [ ] English text remains as fallback when locale files fail to load

- [ ] **Email template i18n**
  - [ ] Verification email renders in Vietnamese when locale is `vi`
  - [ ] Password reset email renders in Vietnamese when locale is `vi`
  - [ ] Emails default to English when no locale is specified
  - [ ] `Accept-Language` header is only used as a fallback when no stored `preferred_locale` exists

- [ ] **Database locale**
  - [ ] `preferred_locale` column exists on `users` table after migration
  - [ ] User registration stores the current browser-selected locale as the initial default
  - [ ] Auth response includes `preferred_locale` field
  - [ ] Locale preference is used for server-side email language selection
  - [ ] Explicit locale changes update the current user record without affecting other users or workspaces

- [ ] **Build and regression**
  - [ ] `npm run build` passes for all packages including new `@blindpass/i18n`
  - [ ] `npm test` passes for all existing test suites
  - [ ] Dashboard Playwright E2E tests still pass
