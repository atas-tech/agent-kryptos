# Phase 1 MVP: Secure Secret Provisioning System

Build a zero-knowledge secret provisioning system enabling Human → Agent secure secret injection with HPKE encryption, Gateway-level anti-phishing, and in-memory-only secret storage.

> [!NOTE]
> **Gateway Integration**: The Gateway component is a standalone middleware module, built and tested independently. Actual OpenClaw Gateway integration deferred to later.

> [!NOTE]
> **Network Scope**: Phase 1 SPS binds to `SPS_HOST` env var (default `127.0.0.1`). For **Telegram/WhatsApp delivery**, either set `SPS_HOST=0.0.0.0` or expose via a tunnel (Tailscale, ngrok). Rate limiting deferred.

---

## Proposed Changes

### Project Structure

```
agent-kryptos/
├── package.json                    # Root workspace config
├── tsconfig.base.json              # Shared TS config
├── packages/
│   ├── sps-server/                 # Secret Provisioning Service backend
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts            # Server entry + static file routing
│   │   │   ├── routes/
│   │   │   │   └── secrets.ts      # All /api/v2/secret/* endpoints
│   │   │   ├── services/
│   │   │   │   ├── redis.ts        # Redis client + TTL operations
│   │   │   │   ├── crypto.ts       # HMAC URL signing, confirmation codes
│   │   │   │   └── audit.ts        # Structured audit logging
│   │   │   ├── middleware/
│   │   │   │   └── auth.ts         # Session token + JWT validation
│   │   │   └── types.ts            # Shared type definitions
│   │   └── tests/
│   │       ├── routes.test.ts      # Endpoint unit tests
│   │       └── crypto.test.ts      # HMAC + code generation tests
│   │
│   ├── browser-ui/                 # Standalone Vite single-page application
│   │   ├── package.json            # Vite + dependencies
│   │   ├── vite.config.js          # Vite configuration
│   │   ├── index.html              # App entry point
│   │   ├── src/                    # Source files
│   │   │   ├── app.js              # UI + state logic
│   │   │   ├── crypto.js           # HPKE encryption wrapper
│   │   │   └── style.css           # Styling
│   │
│   ├── agent-skill/                # Agent-side skill package
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── SKILL.md                # Skill trigger definitions
│   │   ├── src/
│   │   │   ├── index.ts            # Skill entry point
│   │   │   ├── key-manager.ts      # HPKE keypair generation + disposal
│   │   │   ├── secret-store.ts     # In-memory store with zeroing
│   │   │   └── sps-client.ts       # HTTP client for SPS endpoints
│   │   └── tests/
│   │       ├── key-manager.test.ts
│   │       └── secret-store.test.ts
│   │
│   └── gateway/                    # Gateway security middleware
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts            # Middleware entry point
│       │   ├── interceptor.ts      # Intercept request_secret tool calls
│       │   ├── egress-filter.ts    # URL regex DLP on outbound messages
│       │   ├── identity.ts         # Ed25519 Gateway key signing
│       │   └── code-generator.ts   # BLUE-FOX-42 style codes
│       └── tests/
│           ├── interceptor.test.ts
│           └── egress-filter.test.ts
```

---

### 1. Project Setup

#### [NEW] [package.json](package.json)

Root workspace configuration using npm workspaces. Shared scripts for `dev`, `build`, `test`.

#### [NEW] [tsconfig.base.json](tsconfig.base.json)

Shared TypeScript config: `strict: true`, `target: ES2022`, `module: NodeNext`.

---

### 2. SPS Backend (`packages/sps-server/`)

Fastify server with Redis-backed storage. All data auto-expires via Redis TTL (180 seconds = 3 min).

#### [NEW] [index.ts](packages/sps-server/src/index.ts)

- Fastify server on configurable port (default `3100`)
- Registers routes, Redis connection, CORS for browser-ui
- Sets `Referrer-Policy: no-referrer` on all API responses to prevent leaking `?sig=` tokens via referrer headers.
- **Frontend Decoupling**: The backend no longer serves static UI files. It relies on a standalone frontend application configured via `SPS_UI_BASE_URL` (default `http://localhost:5173`) to generate links.

#### [NEW] [secrets.ts](packages/sps-server/src/routes/secrets.ts)

Six endpoints with explicit auth:

| Endpoint | Auth | Behavior |
|----------|------|----------|
| `POST /request` | **Gateway JWT** (`aud:sps`, `role:gateway`) | Store request in Redis with 180s TTL → generate `request_id`, confirmation code, **two scoped HMAC sigs** (`metadata_sig`, `submit_sig`) → return `{request_id, confirmation_code, secret_url}` |
| `GET /metadata/:id` | **`?sig=<exp>.<hmac>`** (scope=metadata) | Return `{public_key, description, confirmation_code, expiry}`. Reject `403` if sig invalid or wrong scope, `410` if expired. |
| `POST /submit/:id` | **`?sig=<exp>.<hmac>`** (scope=submit) | Validate status `"pending"` → store `{enc, ciphertext}` → set status `"submitted"` → **reset TTL to 60s** → `201`. Reject `403` wrong sig, `409` already submitted, `410` expired. |
| `GET /retrieve/:id` | **Gateway JWT** (`aud:sps`, `role:gateway`) | **Atomic GETDEL** via Lua script → return `{enc, ciphertext}` → `200`. Returns `410 Gone` if consumed or expired (no distinction — see note). |
| `GET /status/:id` | **Gateway JWT** (`aud:sps`, `role:gateway`) | Return `{status}` — agent polling loop |
| `DELETE /revoke/:id` | **Gateway JWT** (`aud:sps`, `role:gateway`) | Delete request from Redis |

> [!NOTE]
> **`/retrieve` returns `410 Gone` for both consumed and expired requests.** With atomic GETDEL, we cannot distinguish the two without adding tombstone keys. The agent only needs to know "not available" — the specific reason doesn't affect the re-request flow.

> [!IMPORTANT]
> **Atomic Single-Use Retrieval**: `/retrieve/:id` must use a Redis Lua script or `GETDEL` to atomically read and delete in one operation. Separate GET + DELETE allows concurrent requests to both read before deletion.

```lua
-- Redis Lua script for atomic retrieve + delete
local key = KEYS[1]
local data = redis.call('GET', key)
if data then
  redis.call('DEL', key)
  return data
else
  return nil
end
```

> [!NOTE]
> **TTL Strategy**: Initial request TTL = 180s (3 min). After `/submit`, TTL resets to 60s — enough for the agent to poll and retrieve, but limits how long ciphertext sits in Redis.

#### [NEW] [redis.ts](packages/sps-server/src/services/redis.ts)

- Redis client wrapper (`ioredis`)
- Key format: `sps:request:{id}` → **JSON string** (`SET`/`GET` with `JSON.stringify`/`JSON.parse`, not Redis Hash)
- All keys set with `EX 180` (3-minute TTL), reset to `EX 60` after submit
- `setRequest()`, `getRequest()`, `updateStatus()`, `atomicRetrieveAndDelete()`, `deleteRequest()`

#### [NEW] [crypto.ts](packages/sps-server/src/services/crypto.ts)

- `generateRequestId()` — 32 bytes from `crypto.randomBytes`, hex-encoded
- `generateConfirmationCode()` — two random words + 2-digit number (e.g., `BLUE-FOX-42`) from a hardcoded wordlist
- `signPayload(payload)` — HMAC-SHA256 over canonical payload `{request_id, exp, scope}`. Returns **compact token**: `<exp>.<hmac>` (Base64url-encoded HMAC appended to Unix timestamp).
- `verifyPayload(requestId, scope, token)` — splits token on `.`, extracts `exp`, reconstructs canonical payload `{requestId, exp, scope}`, verifies HMAC. Rejects if `exp < now` or scope mismatch.
- `generateScopedSigs(requestId, exp)` — returns `{metadata_sig, submit_sig}` (two `<exp>.<hmac>` tokens with different scope values).
- **HMAC shared secret**: `SPS_HMAC_SECRET` env var, shared by `sps-server` and `gateway` via root `.env`.

#### [NEW] [auth.ts](packages/sps-server/src/middleware/auth.ts)

- **Browser requests**: Extract `sig` from query param (`<exp>.<hmac>` format). Split on `.` to get `exp`. Reconstruct canonical payload `{request_id (from path), exp, scope (from route: metadata or submit)}`. Verify HMAC. Reject `403` invalid/wrong scope, `410` expired.
- **Agent/Gateway requests**: Ed25519-signed JWT. Required claims: `iss: "gateway"`, `aud: "sps"`, `role: "gateway"`, `exp`, `sub: agent_id`. Public key from Gateway JWKS file.

#### [NEW] [audit.ts](packages/sps-server/src/services/audit.ts)

- Structured JSON logging: `{timestamp, event, request_id, agent_id, action, ip}`
- Events: `request_created`, `secret_submitted`, `secret_retrieved`, `request_expired`, `request_revoked`

---

### 3. Browser Encryption UI (`packages/browser-ui/`)

Standalone Single-Page Application (SPA) built with Vite. It interacts with the SPS backend via absolute URLs (configured via `VITE_SPS_API_URL`).

#### [NEW] [index.html](packages/browser-ui/index.html)

- Clean, minimal form: confirmation code display, textarea for secret, submit button
- States: loading → verify code → enter secret → encrypting → success → expired/error
- Uses ES modules via Vite.

#### [NEW] [src/style.css](packages/browser-ui/src/style.css)

- Dark theme, responsive (mobile-first for Telegram/WhatsApp users)
- Security-focused UX: lock icon, confirmation code prominently displayed

#### [NEW] [src/app.js](packages/browser-ui/src/app.js)

```
1. Parse URL: extract request_id from query `?id=...`, metadata_sig and submit_sig
2. Fetch /api/v2/secret/metadata/:id?sig=metadata_sig → {public_key, confirmation_code}
3. Display confirmation_code prominently
4. On submit:
   a. Import public key (deserialize from base64)
   b. HPKE.Seal(public_key, TextEncoder.encode(secret))
   c. POST /api/v2/secret/submit/:id?sig=submit_sig {enc: base64, ciphertext: base64}
   d. Hide the input box and show success state
5. Handle errors: 403 (invalid sig), 409 (already submitted), 410 (expired)
```

#### [NEW] [src/crypto.js](packages/browser-ui/src/crypto.js)

- Standard ES module importing `@hpke/core`
- Handled via Vite's bundling pipeline instead of a custom build script.

---

### 4. Agent Skill (`packages/agent-skill/`)

#### [NEW] [SKILL.md](packages/agent-skill/SKILL.md)

Skill definition with triggers: "need credentials", "request secret", "API key required".
Instructions for the LLM: **never ask for secrets in chat, always use `request_secret` tool**.

#### [NEW] [key-manager.ts](packages/agent-skill/src/key-manager.ts)

- `generateKeyPair()` — HPKE keypair using `@hpke/core` (Node.js)
- `decrypt(privateKey, enc, ciphertext)` — HPKE.Open
- `destroyKeyPair(keyPair)` — zero out private key `Buffer`, nullify references
- Private keys never logged, never serialized

#### [NEW] [secret-store.ts](packages/agent-skill/src/secret-store.ts)

- `SecretStore` class with `Map<string, Buffer>` (secret name → value)
- Custom `toJSON()` returns `"[REDACTED]"` — prevents accidental serialization
- `store(name, value)` — stores in Map
- `get(name)` — returns **Buffer** (not string)
- `dispose(name)` — zeros buffer, deletes from Map
- `disposeAll()` — zeros and clears all

> [!CAUTION]
> **JS String Immutability Trap**: JavaScript strings are immutable and GC-managed — you cannot zero them. The `get()` method returns a `Buffer`, never a string. Conversion to string (`buf.toString('utf8')`) must happen **only at the last millisecond** (e.g., inline in an HTTP header constructor) and never assigned to a variable. This is a documented rule enforced via code review.

#### [NEW] [sps-client.ts](packages/agent-skill/src/sps-client.ts)

- `requestSecret(description)` — POST /request, returns request_id
- `pollStatus(requestId, intervalMs, pendingTimeoutMs, retrieveGraceMs)` — **blocking** `await` loop with exponential backoff (1s → 2s → 4s, capped at 10s). Uses **two deadlines**: pending window = **180s** while status is `pending`, then retrieval grace window = **60s** once status becomes `submitted`. If both windows expire without retrieval, return structured tool error: `"User did not provide the secret in time. Ask the user if they still want to proceed."`
- `retrieveSecret(requestId)` — GET /retrieve, returns `{enc, ciphertext}`
- Configurable SPS endpoint via env var or constructor param

> [!NOTE]
> The `pollStatus` call **blocks the tool executor** via `await`, preventing the LLM from hallucinating progress or proceeding without the secret.

#### [NEW] [index.ts](packages/agent-skill/src/index.ts)

Orchestration: `requestSecret` → generate keys → call SPS → emit tool call → poll → retrieve → decrypt → store in-memory → destroy keys.

Lazy re-request: if `secretStore.get(name)` returns null when a tool needs it, emit `request_secret` with `re_request: true`.

---

### 5. Gateway Middleware (`packages/gateway/`)

#### [NEW] [interceptor.ts](packages/gateway/src/interceptor.ts)

- Intercepts `request_secret` tool calls from the LLM
- Calls SPS to create request → receives `{request_id, confirmation_code, secret_url}`
- Formats human-readable message with URL + code
- Pushes to chat adapter (Telegram/WhatsApp/etc.)
- Returns **only** `{status: "secret_request_pending", request_id}` to LLM
- LLM never sees URL or confirmation code

#### [NEW] [egress-filter.ts](packages/gateway/src/egress-filter.ts)

- **URL detection**: Use `URL` constructor (not regex) to parse all URL-like strings from outbound messages. Handles markdown links `[text](url)`, bare URLs, and angle-bracket URLs.
- **Hostname normalization**: Convert to punycode, lowercase, strip trailing dots. This defeats homograph attacks (e.g., `sеcrets.yourdomain.com` using Cyrillic `е`).
- **Allowlist**: Compare normalized hostname against configurable list (default: `secrets.yourdomain.com`). Path prefix checked if configured.
- If non-allowlisted URL detected: **redact** the URL, log security alert with original + normalized hostname.
- Returns `{filtered: boolean, original, sanitized, alerts[]}`

#### [NEW] [identity.ts](packages/gateway/src/identity.ts)

- On Gateway startup: **load** Ed25519 root keypair from `GATEWAY_KEY_PATH` (default `./gateway-key.pem`). If file doesn't exist on first run, generate and **persist to disk**.
- `signAgentKey(agentId, publicKey)` — sign agent's HPKE public key with Gateway key
- `verifyAgentKey(signedPayload)` — verify signature
- `issueJWT(agentId, spiffeId, ttl)` — short-lived JWT with claims: `{iss: "gateway", aud: "sps", role: "gateway", sub: agentId, exp}`
- `getJWKS()` — returns public key in JWKS format (for SPS to verify JWTs)

> [!IMPORTANT]
> **Key Rotation**: If the Gateway key is regenerated, all SPS instances must reload the JWKS. Phase 1 uses a shared file; Phase 2+ uses a `/gateway/.well-known/jwks.json` endpoint.

#### [NEW] [code-generator.ts](packages/gateway/src/code-generator.ts)

- Two-word + number format: `ADJECTIVE-NOUN-NN`
- Wordlists: ~100 adjectives, ~100 nouns (easy to read, no ambiguity)
- `generate()` → `"BLUE-FOX-42"` (cryptographically random selection)

---

## Verification Plan

### Automated Tests

All tests use **Vitest**. Run from project root:

```bash
# Run all tests
npm test

# Run specific package tests
npm test --workspace=packages/sps-server
npm test --workspace=packages/agent-skill
npm test --workspace=packages/gateway
```

**SPS Server tests** (`packages/sps-server/tests/`):
- `routes.test.ts`: All 6 endpoints via Fastify `inject()`. Mock Redis with `ioredis-mock`. Verify: status codes, TTL enforcement, submit on expired → `410`, auth rejection on missing/invalid sig/JWT, `Referrer-Policy: no-referrer` header present.
- `routes-adversarial.test.ts`: **Concurrent double-retrieve race** (two parallel `/retrieve` calls — only one succeeds, other gets `410`). **Oversized ciphertext** (submit 10MB payload → `413`). **Replayed HMAC sig** with tampered `exp` → `403`.
- `crypto.test.ts`: `generateRequestId` uniqueness, `generateConfirmationCode` format, canonical HMAC sign/verify round-trip, payload tampering detection.

**Agent Skill tests** (`packages/agent-skill/tests/`):
- `key-manager.test.ts`: Keypair generation, encrypt/decrypt round-trip with HPKE, key zeroing after dispose.
- `secret-store.test.ts`: Store/get/dispose, `toJSON()` returns redacted, buffer zeroed after dispose.

**Gateway tests** (`packages/gateway/tests/`):
- `interceptor.test.ts`: Tool call intercepted, SPS called, response to LLM contains NO url or code.
- `egress-filter.test.ts`: Allowlisted URLs pass, non-allowlisted redacted, mixed content partially redacted. **Adversarial**: homograph attacks (`sеcrets.yourdomain.com` with Cyrillic), markdown-wrapped URLs `[click](http://evil.com)`, URL-encoded bypasses, split-text tricks.
- `identity.test.ts`: **JWT claim validation failures** — expired `exp`, wrong `aud`, missing `role`, tampered signature → all rejected.

### End-to-End Test (Manual)

1. Start SPS server: `cd packages/sps-server && npm run dev`
2. Start Frontend UI: `cd packages/browser-ui && npm run dev`
3. Trigger a request via the CLI or Agent
4. Open the generated Vite URL (e.g., `http://localhost:5173/?id={test_request_id}&...`)
3. Verify confirmation code is displayed
4. Enter test secret, click submit
5. Verify success state is shown
6. Verify agent can retrieve and decrypt the ciphertext
7. Verify second retrieve attempt returns `410` (atomic single-use)

---

## Phase 2A Implementation Plan: Pull-Based Agent-to-Agent Exchange

Implement pull-based Agent → Agent exchange without breaking the existing Human → Agent flow. This phase keeps the current local/dev trust model based on gateway-signed JWTs and adds the minimum new protocol needed for autonomous exchange.

> [!NOTE]
> **Current progress:** The repo now contains the dedicated SPS exchange routes, exchange record/store primitives, fulfillment tokens, per-agent local JWT auth, `secret_name` registry/classification, same-ring allowlist support, agent requester/fulfiller runtime methods, and an end-to-end stub-transport exchange test. Remaining work is primarily Phase 2B scope: production transport, SPIFFE identity, and broader approval/policy workflows.

### Goals

- Preserve all existing Human → Agent behavior and routes
- Add pull-based A2A exchange using stable `secret_name` identifiers
- Bind requester, fulfiller, policy decision, and retrieval ownership in SPS
- Make fulfiller attribution explicit in audit logs
- Prevent multi-fulfiller races with atomic reservation and submit

> [!IMPORTANT]
> **Product-scope note:** Phase 2A validates the full SPS exchange protocol via test harness. It does not ship a production agent-to-agent delivery channel. A real runtime integration (e.g., OpenClaw runtime channel) is required before autonomous A2A is usable in deployment. This ships in Phase 2B alongside SPIFFE identity.

> [!IMPORTANT]
> **Local bootstrap note:** Phase 2A agents get their SPS bearer tokens from a local gateway minting step, not from a runtime HTTP issuance endpoint. The intended dev/test flow is a CLI or harness-generated JWT per agent identity, injected via environment variable such as `SPS_AGENT_TOKEN`.

### Non-Goals

- No browser or chat UX changes for Human → Agent
- No broadcast-to-many fulfiller semantics
- No SPIFFE/SPIRE requirement in Phase 2A
- No Phase 3 capability proxy or token exchange work
- No optional `fulfiller_hint` support until agent discovery and delivery semantics are defined
- No production agent-to-agent transport — Phase 2A uses a stub transport (in-process / test harness)

### Delivery Sequence

#### Milestone 1: Shared Types and Contracts

Update the core server and agent types to represent exchanges as first-class records instead of overloading the current human request schema.

**Files**

- `packages/sps-server/src/types.ts`
- `packages/agent-skill/src/sps-client.ts`
- `packages/agent-skill/src/index.ts`

**Changes**

- Add `ExchangeStatus = "pending" | "reserved" | "submitted" | "retrieved" | "revoked" | "expired" | "denied"`
- Add `PolicyDecision` type with `mode`, `approvalRequired`, `ruleId`, `reason`, `approvalReference`
- Add `StoredExchange` type:
  - `exchangeId`
  - `requesterId`
  - `requesterPublicKey`
  - `secretName`
  - `purpose`
  - `allowedFulfillerId?`
  - `fulfilledBy?`
  - `policyDecision`
  - `status`
  - `createdAt`
  - `expiresAt`
  - `enc?`
  - `ciphertext?`
- Add client-side request/response types for:
  - `createExchangeRequest`
  - `fulfillExchange`
  - `submitExchange`
  - `getExchangeStatus`
  - `retrieveExchange`

**Acceptance**

- All new route payloads have explicit TS interfaces
- Human request types remain intact and do not regress

#### Milestone 2: SPS Storage and Atomic State Transitions

Extend the store layer so exchanges have their own Redis keys and atomic transitions.

**Files**

- `packages/sps-server/src/services/redis.ts`
- `packages/sps-server/src/types.ts`

**Changes**

- Introduce exchange key space: `sps:exchange:{id}`
- Add store methods for exchange lifecycle:
  - `setExchange()`
  - `getExchange()`
  - `revokeExchange(exchangeId)` — soft-delete: set `status: "revoked"` and reset TTL to **300s** (5-min tombstone)
  - `reserveExchange(exchangeId, fulfillerId)` atomically moves `pending -> reserved`
  - `submitExchange(exchangeId, fulfillerId, enc, ciphertext, ttlSeconds)` compare-and-set on `status=reserved` and `fulfilledBy`
  - `atomicRetrieveExchange(exchangeId, requesterId)` compare requester ownership and atomically return + delete
- Use Redis Lua for reservation, submit, and retrieve to avoid read-modify-write races
- Mirror the same semantics in `InMemoryRequestStore` for tests

**Acceptance**

- Two parallel fulfill attempts cannot both reserve the same exchange
- Non-reserved agents cannot overwrite ciphertext
- Only the requester can retrieve
- Revoked exchange persists as tombstone for 5 minutes, blocking fulfill/submit/retrieve during that window
- **No separate reservation lease** — reserved exchanges expire at the original exchange TTL. If A crashes after reserving, B waits for expiry or manually revokes. No alternate-fulfiller retry path in Phase 2A.

#### Milestone 3: SPS Token and Auth Primitives

Add SPS-signed fulfillment tokens and cleanly separate agent auth from browser signatures.

**Files**

- `packages/sps-server/src/services/crypto.ts`
- `packages/sps-server/src/middleware/auth.ts`

**Changes**

- Add fulfillment token signing and verification helpers
- Add local/dev gateway minting support for per-agent JWTs:
  - one token per agent identity
  - unique `sub` per token
  - short-lived expiration suitable for dev/test runs
  - intended bootstrap shape: CLI or harness injection via env var
- Token claims:
  - `iss`
  - `aud`
  - `exchange_id`
  - `requester_id`
  - `secret_name`
  - `purpose`
  - `exp`
  - `policy_hash`
  - `approval_reference`
- Keep Human → Agent browser signature logic unchanged
- **Refactor `requireGatewayAuth` to extract per-agent identity from JWT `sub` claim.** The current auth path accepts a single shared `role: "gateway"` token — Phase 2A must extend the gateway to issue agent-specific JWTs with unique `sub` claims (e.g., `sub: "agent:crm-bot"`) so SPS can enforce requester/fulfiller ownership. Add a new `requireAgentAuth` helper that validates `sub` and returns the authenticated agent ID to route handlers.

**Acceptance**

- SPS can mint and verify a fulfillment token without exposing requester public key until fulfillment
- Expired or tampered tokens fail cleanly
- Replayed tokens fail once the exchange is no longer `pending`
- **Two agents with different `sub` claims are distinguishable by SPS auth — a JWT for agent A cannot pass ownership checks for agent B**
- **Fulfillment with a stale `policy_hash` is rejected — if policy changes after exchange creation, the token becomes unfulfillable**
- Local/dev agents can start with distinct bearer tokens without requiring a token-minting HTTP service

#### Milestone 4: SPS Exchange Routes

Add dedicated A2A endpoints without disturbing existing Human → Agent routes.

**Files**

- `packages/sps-server/src/routes/exchange.ts` **(new file — exchange routes live in a dedicated module)**
- `packages/sps-server/src/services/audit.ts`

**Changes**

- Add `POST /api/v2/secret/exchange/request`
  - authenticate requester B
  - validate `secret_name` and `purpose`
  - require `fulfiller_hint` in Phase 2A
  - evaluate static allowlist policy and **bind policy snapshot + `policy_hash`** to the exchange record
  - persist exchange with `status=pending`
  - return `exchange_id`, `status`, `expires_at`, `fulfillment_token`, `policy`
- Add `POST /api/v2/secret/exchange/fulfill`
  - authenticate fulfiller A
  - verify token
  - **verify `policy_hash` from token matches current policy hash** — reject `409` on mismatch (B must re-request)
  - atomically reserve exchange
  - return requester metadata and `fulfilled_by`
  - replay after `reserved`, `submitted`, `revoked`, or `expired` must fail without changing state
- Add `POST /api/v2/secret/exchange/submit/:id`
  - authenticate A
  - compare-and-set `reserved -> submitted`
  - reset retrieval TTL
  - return `retrieve_by`, `fulfilled_by`
- Add `GET /api/v2/secret/exchange/retrieve/:id`
  - authenticate B
  - atomically get and delete only if requester matches
  - return `enc`, `ciphertext`, `secret_name`, `fulfilled_by`
  - return a generic not-available response for non-owner, missing, expired, revoked, or already-consumed exchanges
- Add `GET /api/v2/secret/exchange/status/:id`
  - authenticate requester
  - return current status
- Add `DELETE /api/v2/secret/exchange/revoke/:id`
  - authenticate requester or admin
  - soft-delete: set `status: "revoked"` + reset TTL to 300s tombstone
  - **authorized revoke returns `200` with `{ "status": "revoked" }`** (control-plane success signal)
  - unauthorized / non-owner probes still get generic "not available" (anti-enumeration)
- Add A2A audit events:
  - `exchange_requested`
  - `exchange_reserved`
  - `exchange_submitted`
  - `exchange_retrieved`
  - `exchange_revoked`
  - `exchange_denied`

**Acceptance**

- Human → Agent routes still pass unchanged
- Exchange routes enforce requester and fulfiller ownership
- Audit events include `exchange_id`, `secret_name`, `requester_id`, `fulfilled_by`, `policy_rule_id`, `approval_reference`

#### Milestone 5: Policy Layer for Phase 2A

Start with a static, explicit policy implementation keyed by `secret_name`.

**Files**

- `packages/sps-server/src/services/` new policy module, for example `policy.ts`
- `packages/sps-server/src/index.ts`
- configuration docs / env handling as needed

**Changes**

- Add a small local policy engine:
  - input: `requesterId`, `secretName`, `purpose`, `fulfillerHint`
  - output: `PolicyDecision`
- Start with config-driven allowlists:
  - exact `secret_name`
  - allowed requester IDs
  - allowed fulfiller IDs
  - optional same-ring shortcut if encoded in agent IDs
- Deny by default
- No free sharing across same ring

**Acceptance**

- A request for an unknown `secret_name` is denied
- A requester cannot name an arbitrary fulfiller outside the allowlist

#### Milestone 6: Agent Skill Requester Flow

Extend the runtime so an agent can request a secret from another agent using the new SPS exchange contract.

**Files**

- `packages/agent-skill/src/sps-client.ts`
- `packages/agent-skill/src/index.ts`

**Changes**

- Add client methods:
  - `createExchangeRequest()`
  - `getExchangeStatus()`
  - `retrieveExchange()`
- Extend requester polling:
  - add `reservedTimeoutMs` for stalled `reserved` exchanges
  - if status remains `reserved` longer than the timeout, fail fast locally
  - issue best-effort `DELETE /api/v2/secret/exchange/revoke/:id` as cleanup
- Add runtime orchestration for requester B:
  - generate ephemeral HPKE keypair
  - call `createExchangeRequest`
  - deliver `fulfillment_token` to target agent via **stub transport** (in-process handoff or test harness; production transport deferred to Phase 2B)
  - poll exchange status
  - retrieve and decrypt
  - store in `SecretStore` under `secret_name`
- Ensure missing secret logic still supports Human → Agent lazy re-request when no A2A policy exists

**Acceptance**

- A requester can fetch a secret from another agent without using browser UI
- Existing `requestAndStoreSecret()` Human → Agent path remains functional
- A stalled `reserved` exchange does not block requester B until full exchange expiry

#### Milestone 7: Agent Skill Fulfiller Flow

Allow an authorized agent that already holds a secret to fulfill a request safely.

**Files**

- `packages/agent-skill/src/sps-client.ts`
- `packages/agent-skill/src/index.ts`
- `packages/agent-skill/src/secret-store.ts`

**Changes**

- Add client methods:
  - `fulfillExchange()`
  - `submitExchange()`
- Add runtime orchestration for fulfiller A:
  - receive `fulfillment_token`
  - call `fulfillExchange`
  - look up `secret_name` in local in-memory store
  - if missing, fail closed with a structured error
  - encrypt to requester public key
  - submit ciphertext
- Do not allow a fulfiller to synthesize a secret from chat context; it must come from local trusted state

**Acceptance**

- A fulfiller without the secret does not degrade into Human → Agent automatically
- A fulfiller can only submit after SPS reservation succeeds

#### Milestone 8: Gateway and Transport Boundaries

Keep Gateway changes minimal in Phase 2A. Fulfillment token delivery uses a **stub transport** — production agent-to-agent transport ships in Phase 2B alongside SPIFFE identity.

**Files**

- `packages/gateway/src/identity.ts`
- `packages/gateway/src/sps-client.ts`

**Changes**

- Reuse current gateway-issued JWTs for agent auth to SPS
- Add a local/dev minting path for per-agent JWTs:
  - CLI command or harness helper
  - inject token into each agent process separately
  - no runtime HTTP issuance endpoint in Phase 2A
- No browser or human notification changes required for A2A
- Fulfillment token delivery in Phase 2A is in-process (test harness passes token directly between agent instances)
- Production transport (OpenClaw runtime channel or equivalent) deferred to Phase 2B

**Acceptance**

- Gateway JWT issuance remains compatible with both Human → Agent and A2A endpoints
- Integration tests pass the fulfillment token between agents without requiring a real transport channel
- Two local agent instances can be launched with distinct minted JWTs and complete an exchange end-to-end

### Testing Plan

#### SPS Server

- `exchange-routes.test.ts`
  - create exchange success
  - deny unknown `secret_name`
  - deny unauthorized fulfiller hint
  - fulfill reserves exchange
  - second fulfill gets `409`
  - replayed fulfillment token after `reserved` gets rejected
  - replayed fulfillment token after `submitted` or `revoked` gets rejected
  - submit by non-reserved fulfiller gets `409`
  - retrieve by non-requester gets the same generic not-available response as a missing or expired exchange
  - revoke prevents later submit and retrieve
- `exchange-store.test.ts`
  - Lua reservation semantics
  - compare-and-set submit semantics
  - atomic retrieve semantics with requester binding
- `exchange-token.test.ts`
  - sign/verify round-trip
  - tampered `secret_name`
  - expired token
  - mismatched `policy_hash`

#### Agent Skill

- requester flow success end-to-end with mocked SPS
- fulfiller flow success with local secret present
- fulfiller flow fails closed when secret missing
- requester cannot retrieve after expiration
- requester times out stalled `reserved` exchanges and performs best-effort revoke
- Human → Agent runtime still passes existing tests

#### Integration

- two agents, one SPS, one Redis (fulfillment token passed via **stub transport** — in-process handoff)
- agent B requests `stripe.api_key.prod` from agent A
- agent A reserves and submits
- agent B retrieves and decrypts
- concurrent second fulfiller attempt is rejected
- revoked exchange returns generic "not available" to non-owner probes (anti-enumeration)
- authorized revoke returns `200` with `{ "status": "revoked" }` (control-plane success)
- fulfill with stale `policy_hash` returns `409`
- reserved exchange with crashed fulfiller expires at original TTL (no separate lease)
- audit log contains `fulfilled_by`

### Suggested Work Breakdown

1. Types + token helpers
2. Redis atomic exchange primitives
3. SPS exchange routes
4. Agent requester flow
5. Agent fulfiller flow
6. Policy module
7. Tests and hardening

### Resolved Decisions

- **Exchange routes** → dedicated `routes/exchange.ts` (separate from H2A `secrets.ts`)
- **Revocation** → soft-delete with tombstone + 5-min TTL (audit log retains event permanently)
- **Transport** → stub transport (in-process) for Phase 2A; production transport deferred to Phase 2B alongside SPIFFE
- **Local JWT bootstrap** → per-agent JWT minted by local CLI/harness and injected into each agent; no runtime HTTP issuance endpoint in Phase 2A
- **Reserved stall handling** → requester-side `reservedTimeoutMs` with best-effort revoke cleanup; no separate reservation lease in Phase 2A

### Open Decisions Before Coding

- Whether optional `fulfiller_hint` should be revisited after transport/discovery semantics exist

---

### Security Validation

1. **Zero-knowledge**: Inspect Redis during live request — only `enc` + `ciphertext`, no plaintext
2. **TTL expiry**: Create request, wait 3+ min, verify `410 Gone`
3. **TTL reset**: Submit, verify retrieval window is 60s (not 180s)
4. **Atomic retrieve**: Two concurrent `/retrieve` calls — exactly one succeeds
5. **Egress filter**: `https://evil.com/steal` through filter → redacted
6. **Homograph filter**: `https://sеcrets.yourdomain.com` (Cyrillic е) → redacted
7. **LLM blindness**: Interceptor response contains no URL or code
8. **JWT enforcement**: `/request` without valid JWT → `401`
9. **HMAC tampering**: `/metadata` with modified `exp` in sig → `403`
10. **Oversized payload**: `/submit` with 10MB body → `413`
11. **Referrer leakage protection**: `GET /r/:id?...` and `/api/v2/secret/*` responses include `Referrer-Policy: no-referrer`
