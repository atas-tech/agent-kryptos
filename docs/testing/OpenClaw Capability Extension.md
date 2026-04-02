# OpenClaw Capability Extension Test Plan

This document defines the End-to-End (E2E), integration, packaging, and operational verification scenarios for the OpenClaw capability-extension roadmap in `docs/plugins/openclaw-capability-extension.md`.

## Scope

This plan covers:

- OpenClaw packaging and ClawHub distribution
- Managed secret persistence through the BlindPass encrypted store
- `blindpass-resolver` exec-provider integration with OpenClaw SecretRefs
- MCP server support for Codex, Claude Code, Antigravity, and other MCP-compatible agents
- Dist-repo and npm release integrity

## Milestone 1: Build, Bundle, and Package Boundaries

- [ ] **Bundle outputs are self-contained**
  - [ ] `npm run build:skill` emits `blindpass.mjs`, `mcp-server.mjs`, and `blindpass-resolver.mjs`
  - [ ] Published bundle output contains no monorepo-relative import paths such as `packages/gateway/dist` or `packages/agent-skill/dist`
  - [ ] Bundle output contains no `.env` files, private keys, workspace paths, or local SPS URLs

- [ ] **Release metadata stays synchronized**
  - [ ] `SKILL.md`, `openclaw.plugin.json`, and dist `package.json` report the same release version
  - [ ] ClawHub-facing metadata includes the expected OpenClaw requirements and installable skill metadata
  - [ ] npm package metadata correctly exposes the MCP server and resolver entry points

- [ ] **Audience-specific packaging works**
  - [ ] OpenClaw users can install via ClawHub without needing the MCP-only packaging path
  - [ ] MCP users can install via npm or run via `npx` without needing OpenClaw-specific config files
  - [ ] Git dist-repo installer remains a functional fallback for manual or offline installs

## Milestone 2: Managed Secret Storage

- [ ] **Managed mode persists without exposing plaintext**
  - [ ] `request_secret` with `secret_name` and default managed settings stores the secret in the encrypted store
  - [ ] Tool output returns metadata only and never includes the secret value
  - [ ] Audit entries record metadata only and never include plaintext, ciphertext, tokens, or key material

- [ ] **Managed mode fails closed when persistence is unavailable**
  - [ ] If `BLINDPASS_AUTO_PERSIST=true` and `sops` is missing, the request fails with an actionable error
  - [ ] If the configured store path is invalid or unwritable, the request fails without downgrading silently to runtime-only mode
  - [ ] The plugin does not claim the secret is stored when persistence failed

- [ ] **Explicit runtime-only mode is isolated**
  - [ ] If `BLINDPASS_AUTO_PERSIST=false`, the secret is kept only in runtime memory
  - [ ] Runtime-only secrets are not listed by the managed-store listing tool
  - [ ] Runtime-only secrets are not resolvable by `blindpass-resolver`

- [ ] **Managed-store maintenance operations**
  - [ ] `store_secret` writes to the managed store and returns metadata only (never echoes the value)
  - [ ] `store_secret` fails closed if managed store is unavailable
  - [ ] `list_secrets` returns names only
  - [ ] `delete_secret` removes the managed secret and records a metadata-only audit event
  - [ ] Rotation via `request_secret` with `re_request=true` replaces the stored value atomically

- [ ] **Deployment-level plaintext control**
  - [ ] With `BLINDPASS_ALLOW_EXPOSE_PLAINTEXT=false` (default), `request_secret` returns metadata only
  - [ ] With `BLINDPASS_ALLOW_EXPOSE_PLAINTEXT=true`, `request_secret` returns the decrypted value alongside metadata
  - [ ] The model cannot override this setting via tool parameters
  - [ ] `store_secret` never echoes the value back regardless of the plaintext control setting

- [ ] **Platform-aware store path resolution**
  - [ ] On Linux/macOS, convention path resolves to `$HOME/.blindpass/`
  - [ ] On Windows, convention path resolves to `%LOCALAPPDATA%\blindpass\`
  - [ ] `BLINDPASS_STORE_PATH` overrides platform detection on all platforms

## Milestone 3: Resolver and OpenClaw SecretRef Integration

- [ ] **Resolver protocol compliance**
  - [ ] `blindpass-resolver` accepts exec-provider protocol v1 requests on stdin
  - [ ] Successful batch lookup returns a `values` object keyed by requested IDs
  - [ ] Missing, expired, or deleted secrets return `errors` entries without leaking store internals

- [ ] **OpenClaw activation behavior is correct**
  - [ ] Provision secret → restart gateway → SecretRef resolves successfully
  - [ ] Provision secret → run `openclaw secrets reload` → SecretRef resolves successfully
  - [ ] Provision secret without reload or restart does not update already-materialized SecretRef consumers
  - [ ] Update existing secret value on disk and verify the old snapshot remains active until reload/restart

- [ ] **TTL and error handling**
  - [ ] Expired secrets fail closed at resolver time with a deterministic error
  - [ ] Corrupt store contents fail closed without emitting plaintext or key material
  - [ ] Resolver timeout and malformed-input paths return protocol-safe error responses

## Milestone 4: MCP Multi-Agent Support

- [ ] **Tool parity across OpenClaw and MCP**
  - [ ] MCP server exposes `request_secret`
  - [ ] MCP server exposes `request_secret_exchange`
  - [ ] MCP server exposes `fulfill_secret_exchange`
  - [ ] MCP server exposes `store_secret`
  - [ ] MCP server exposes `list_secrets`
  - [ ] MCP server exposes `delete_secret`

- [ ] **Managed mode remains metadata-only over MCP**
  - [ ] `request_secret` in managed mode returns storage metadata and reload guidance, not plaintext
  - [ ] `request_secret_exchange` in managed mode behaves the same way
  - [ ] Logs and MCP responses never echo secret values

- [ ] **Agent compatibility smoke coverage**
  - [ ] Claude Code config launches the MCP server successfully
  - [ ] Codex/OpenAI agent config launches the MCP server successfully
  - [ ] Antigravity/Gemini config launches the MCP server successfully
  - [ ] Shared skill instructions remain consistent with the actual tool contracts

## Milestone 5: Distribution and Operational Readiness

- [ ] **ClawHub and npm publishing**
  - [ ] ClawHub publish path succeeds from the staged dist output
  - [ ] npm publish path succeeds for `@blindpass/mcp-server`
  - [ ] Published tarballs contain only intended release artifacts

- [ ] **Installer and dist-repo integrity**
  - [ ] `scripts/install_skill.sh --mode global --agent codex` installs the expected files
  - [ ] `scripts/install_skill.sh --mode global --agent claude` installs the expected files
  - [ ] `scripts/install_skill.sh --mode global --agent antigravity` installs the expected files
  - [ ] `scripts/install_skill.sh --mode global --agent all` does not overwrite unrelated user config without confirmation or backup

- [ ] **End-to-end managed secret lifecycle**
  - [ ] Request from human via SPS → persist to store → reload OpenClaw secrets → SecretRef consumer resolves
  - [ ] Request from another agent via exchange → persist to store → reload → SecretRef consumer resolves
  - [ ] Delete secret → reload → SecretRef consumer fails closed
  - [ ] Rotate secret → reload → SecretRef consumer resolves the new value only after reload

## Exit Criteria

- Managed-secret mode never returns plaintext to the model by default (`BLINDPASS_ALLOW_EXPOSE_PLAINTEXT=false`)
- Plaintext exposure is exclusively operator-controlled via deployment environment variable
- OpenClaw SecretRef behavior is documented and validated as reload-based, not live-updating
- Cross-agent MCP support ships from the same shared core without regressing the OpenClaw plugin path
- Platform-aware store path resolution works on Linux, macOS, and Windows
- Release artifacts are bounded, auditable, and free from local development leakage
