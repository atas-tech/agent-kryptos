# OpenClaw Plugin: Capability Extension Brainstorm

> **Status:** Final · All decisions resolved  
> **Date:** 2026-04-02  
> **Scope:** ClawHub publishing + Secrets Manager integration + Multi-agent compatibility

---

## Table of Contents

- [1. Context & Current State](#1-context--current-state)
- [2. Capability A: Publish to ClawHub + npm](#2-capability-a-publish-to-clawhub--npm)
- [3. Capability B: OpenClaw Secrets Manager Integration](#3-capability-b-openclaw-secrets-manager-integration)
- [4. Capability C: Multi-Agent Compatibility via MCP](#4-capability-c-multi-agent-compatibility-via-mcp)
- [5. Distribution Strategy](#5-distribution-strategy)
- [6. Architecture Overview](#6-architecture-overview)
- [7. Implementation Phases](#7-implementation-phases)
- [8. Resolved Decisions](#8-resolved-decisions)
- [9. Additional Considerations](#9-additional-considerations)

---

## 1. Context & Current State

### What we have today

The `packages/openclaw-plugin` is a native OpenClaw plugin that registers three tools:

| Tool | Purpose |
|---|---|
| `request_secret` | Request a secret from a human via encrypted browser link |
| `request_secret_exchange` | Request a secret from another agent via SPS pull protocol |
| `fulfill_secret_exchange` | Fulfill an incoming agent-to-agent exchange |

**Current secret storage** is entirely **in-memory** (`_inMemorySecrets` Map of `Buffer` objects). The plugin attempts to delegate to runtime `setSecret`/`storeSecret` if available, but falls back to its own volatile Map. Secrets are lost on restart and never persisted to disk or an external vault.

### Key files

| File | Role |
|---|---|
| `index.mjs` | Plugin entry — tool registration, in-memory store, message routing |
| `sps-bridge.mjs` | SPS client wrapper — HPKE, JWT auth, poll/retrieve flows |
| `agent-transport.mjs` | Agent-to-agent delivery — session resolution, message formatting |
| `openclaw.plugin.json` | Plugin manifest (id, config schema, skill refs) |
| `skills/blindpass/SKILL.md` | Agent skill instructions |
| `package.json` | NPM package metadata |

---

## 2. Capability A: Publish to ClawHub + npm

### Distribution channels

BlindPass will be distributed through **four channels**:

| Channel | Install command | Audience |
|---|---|---|
| **ClawHub** | `openclaw skills install blindpass` | OpenClaw users |
| **npm** | `npm install -g @blindpass/openclaw-plugin` | Advanced / self-host users |
| **Git** | `./scripts/install_skill.sh --mode global --agent all` | Any agent (Codex, Claude, Antigravity) |
| **MCP** | `npx @blindpass/mcp-server` | Any MCP-compatible agent |

ClawHub, npm, and git channels receive the same **compiled bundle** — not raw source.

### Reference: How dependency-guard does it

The [atas-tech/dependency-guard](https://github.com/atas-tech/dependency-guard) repo is a working model:

- `SKILL.md` frontmatter with `metadata` as single-line JSON (OpenClaw parser requirement)
- `metadata.openclaw.requires.bins` for CLI dependency filtering
- `version` in frontmatter as single source of truth for ClawHub
- `scripts/publish_clawhub.sh` builds a clean staging bundle
- `scripts/install_skill.sh` supports multi-agent install modes

### What we need to build

#### 2.1 Compiled bundle

The current `index.mjs` dynamically imports sibling monorepo packages (`packages/gateway/dist/`, `packages/agent-skill/dist/`). For distribution, we need to **compile into a self-contained ESM bundle** using esbuild or rollup.

```
src/                          dist/ (published)
├── index.mjs          ──►    ├── blindpass.mjs             (OpenClaw plugin bundle)
├── sps-bridge.mjs             ├── mcp-server.mjs            (MCP server bundle)
├── agent-transport.mjs        ├── blindpass-resolver.mjs     (exec provider CLI)
├── encrypted-store.mjs        ├── openclaw.plugin.json
├── blindpass-resolver.mjs     ├── skills/blindpass/SKILL.md
└── mcp-server.mjs             └── LICENSE
```

The bundle inlines the needed exports from `@blindpass/gateway` and `@blindpass/agent-skill` so the distributed plugin has **zero monorepo dependencies**. The SPS server remains a separate service (hosted or self-hosted).

#### 2.2 Update `SKILL.md` frontmatter

```yaml
---
name: "blindpass"
version: "0.1.0"
description: "Zero-knowledge secret provisioning via HPKE encryption. Request secrets from humans or other agents without exposing plaintext."
metadata: {"openclaw":{"emoji":"🔐","requires":{"bins":[]}}}
---
```

> Once we ship `blindpass-resolver` as a standalone CLI, add it to `requires.bins`.

#### 2.3 Scripts

| Script | Purpose |
|---|---|
| `scripts/build_bundle.sh` | esbuild compile → `dist/` |
| `scripts/publish_clawhub.sh` | Validate, bump version, stage, `clawhub publish` |
| `scripts/install_skill.sh` | Multi-agent installer (codex, claude, antigravity, openclaw, clawhub, all) |

#### 2.4 Security validation in publish

`publish_clawhub.sh` must verify before staging:
- No `.env` files in bundle
- No private keys or identity files
- No `node_modules/` or monorepo-specific paths
- No hardcoded SPS URLs pointing to local/dev instances

#### 2.5 Version synchronization

Three version fields exist: `SKILL.md` frontmatter, `openclaw.plugin.json`, and `package.json`. Strategy:

- **`SKILL.md` version** is the single source of truth (ClawHub convention)
- `scripts/publish_clawhub.sh --bump patch|minor|major` increments SKILL.md and syncs to `package.json` + `openclaw.plugin.json`

---

## 3. Capability B: OpenClaw Secrets Manager Integration

### How OpenClaw Secrets Management Works

OpenClaw has a robust secrets system built around the **SecretRef** contract:

```jsonc
{ "source": "env" | "file" | "exec", "provider": "default", "id": "..." }
```

| Source | How it works |
|---|---|
| `env` | Reads from environment variables |
| `file` | Reads from a local JSON file |
| `exec` | Runs an external binary that returns values via JSON protocol |

OpenClaw already has **built-in SOPS support** in its exec integration examples, making SOPS the natural encryption backend for BlindPass.

### The `exec` provider protocol

**Request (stdin):**
```json
{ "protocolVersion": 1, "provider": "blindpass", "ids": ["stripe.api_key.prod"] }
```

**Success (stdout):**
```json
{ "protocolVersion": 1, "values": { "stripe.api_key.prod": "<secret-value>" } }
```

**Error (stdout):**
```json
{ "protocolVersion": 1, "values": {}, "errors": { "stripe.api_key.prod": { "message": "not found" } } }
```

### Integration strategy: BlindPass as an `exec` provider backed by SOPS

#### 3.1 `blindpass-resolver` CLI

A compiled Node.js CLI binary that:

1. Reads the exec protocol request from stdin
2. Decrypts the SOPS-encrypted secret store
3. Resolves each requested ID from the decrypted data
4. Returns values via stdout (never logs plaintext)

**Key constraint:** The exec provider runs at **activation time** (startup/reload), not lazily. Secrets must be pre-provisioned before the gateway starts.

#### 3.2 SOPS-encrypted secret store

```
<gateway-config-dir>/blindpass/  (or ~/.blindpass/ for MCP)
├── secrets.enc.json    # SOPS-encrypted JSON
└── .sops.yaml          # SOPS config (age key, KMS refs, etc.)
```

Default store locations:
- **OpenClaw**: `<gateway-config-dir>/blindpass/secrets.enc.json` (per gateway)
- **MCP Agents**: `~/.blindpass/secrets.enc.json` (user home directory)

The location is fully configurable via:
- `BLINDPASS_STORE_PATH` env var
- `--store` CLI flag on the resolver

**Why per-gateway?** OpenClaw supports [multiple gateways](https://docs.openclaw.ai/gateway/multiple-gateways). Each gateway has its own config directory, so secrets are naturally scoped per-gateway. This avoids concurrent read/write issues and follows the OpenClaw convention.

#### 3.3 SOPS key bootstrapping

On first use (when no store exists), the plugin:
1. Auto-generates an `age` identity key at `<store-dir>/.age-key.txt` using Node's native `crypto.generateKeyPairSync('x25519')` and formatting it to the `age` identity string format. This avoids needing the external `age-keygen` binary.
2. Creates a `.sops.yaml` config pointing to the age key
3. Initializes an empty encrypted store

This gives users SOPS encryption with zero configuration. Advanced users can reconfigure `.sops.yaml` to use AWS KMS, GCP KMS, Azure Key Vault, or PGP instead.

#### 3.4 OpenClaw configuration example

```jsonc
{
  "secrets": {
    "providers": {
      "blindpass": {
        "source": "exec",
        // 💡 Note: If installed via npm, "blindpass-resolver" may be on your PATH.
        // If installed via ClawHub, use the absolute path to the script using node:
        "command": "node",
        "args": [
          "~/.openclaw/skills/blindpass/dist/blindpass-resolver.mjs",
          "--store", 
          "~/.openclaw/blindpass/secrets.enc.json"
        ],
        "passEnv": ["SOPS_AGE_KEY_FILE"],
        "jsonOnly": true
      }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "apiKey": {
          "source": "exec",
          "provider": "blindpass",
          "id": "openai.api_key"
        }
      }
    }
  }
}
```

#### 3.5 Simplified onboarding flow

When a user installs the BlindPass plugin, the only configuration needed is:

| Config | Default | Notes |
|---|---|---|
| `SPS_BASE_URL` | `https://sps.blindpass.dev` | Hosted service by default |
| `BLINDPASS_AGENT_ID` | `blindpass-agent` | Stable agent identity |
| `BLINDPASS_API_KEY` | *(required)* | Agent bootstrap API key — the **only secret** users need to provision manually |

The `BLINDPASS_API_KEY` can itself be a SecretRef (env source), keeping the setup minimal. All subsequent secrets (API keys, tokens, etc.) are provisioned through the `request_secret` tool and automatically persisted to the SOPS store.

**Onboarding in 3 steps:**
1. `openclaw skills install blindpass`
2. Set `BLINDPASS_API_KEY` env var (or use `openclaw secrets configure` to store it as a SecretRef)
3. The agent calls `request_secret` when it needs a secret → user enters via browser → stored in SOPS

> **Note on Runtime Propagation:** When a new secret is provisioned, the plugin caches it in memory for its own immediate use. However, the OpenClaw gateway's `exec` provider only reads the SOPS file during startup or a secret reload. If other plugins or core models need the newly provisioned secret immediately via the `exec` provider, a **manual reload** is required (e.g., `openclaw secrets reload` or gateway restart).

#### 3.6 Secret lifecycle with OpenClaw integration

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SECRET LIFECYCLE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. PROVISION (interactive, via agent)                              │
│     Agent calls request_secret → User enters via browser            │
│     → HPKE decrypt → plaintext in memory                           │
│                                                                     │
│  2. PERSIST (automatic, configurable)                               │
│     Plugin encrypts via SOPS → writes to gateway store              │
│     <gateway-config>/blindpass/secrets.enc.json                     │
│     Config: BLINDPASS_AUTO_PERSIST=true (default)                   │
│                                                                     │
│  3. REFERENCE (at gateway activation)                               │
│     OpenClaw gateway starts → calls blindpass-resolver              │
│     → resolver decrypts SOPS store → returns to gateway             │
│     → gateway holds in active snapshot                               │
│                                                                     │
│  4. ROTATE                                                          │
│     Agent calls request_secret (re_request: true)                   │
│     → new value replaces old in SOPS store                          │
│     → openclaw secrets reload refreshes snapshot                    │
│                                                                     │
│  5. AUDIT                                                           │
│     openclaw secrets audit → verifies all refs resolve              │
│     No plaintext at rest — SOPS encrypted                           │
│                                                                     │
│  6. DISPOSE                                                         │
│     Gateway shutdown hook zeros in-memory buffers                   │
│     SOPS store persists across restarts                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 3.7 Changes to existing plugin code

**`persistSecret()` — add SOPS backend:**

```javascript
async function persistSecret(api, context, name, value) {
    // 1. Try runtime store (existing behavior)
    for (const target of runtimeTargets) { ... }

    // 2. Write to SOPS store if auto-persist is enabled (NEW)
    if (isAutoPersistEnabled()) {
        await writeToSopsStore(name, value);
    }

    // 3. Also keep in memory for immediate access
    setInMemorySecret(name, value);
    return isAutoPersistEnabled() ? "sops-store" : "plugin";
}
```

**Config flag:** `BLINDPASS_AUTO_PERSIST` (default: `true`)
- `true`: Every secret received via `request_secret` is automatically persisted to the SOPS store
- `false`: Secrets live only in memory (current behavior)

#### 3.8 New tools

**`store_secret`** — Explicitly store a secret the agent already has:

```javascript
api.registerTool({
    name: "store_secret",
    description: "Store a secret in the BlindPass SOPS store for OpenClaw SecretRef reference.",
    parameters: {
        type: "object",
        properties: {
            secret_name: { type: "string" },
            secret_value: { type: "string" },
        },
        required: ["secret_name", "secret_value"],
    },
});
```

> **Trade-off:** `store_secret` accepts plaintext in params (passes through LLM context). For human-originated secrets, `request_secret` remains preferred (client-side encryption).

**`list_secrets`** — List available secret names (never values):

```javascript
api.registerTool({
    name: "list_secrets",
    description: "List secret names in the BlindPass store (values never shown).",
    parameters: { type: "object", properties: {} },
});
```

**`delete_secret`** — Remove a secret from the BlindPass SOPS store:

```javascript
api.registerTool({
    name: "delete_secret",
    description: "Delete a secret from the BlindPass SOPS store.",
    parameters: {
        type: "object",
        properties: {
            secret_name: { type: "string" },
        },
        required: ["secret_name"],
    },
});
```

---

## 4. Capability C: Multi-Agent Compatibility via MCP

### The problem

Today **BlindPass only works with OpenClaw** via its native plugin API. But the same zero-knowledge secret provisioning is valuable for **any** coding agent — Codex, Claude Code, Antigravity/Gemini, and future MCP-compatible agents.

These agents don't support OpenClaw's plugin system, but they all speak **MCP** (Model Context Protocol) over stdio.

### Solution: Standalone MCP server

Build a **BlindPass MCP server** that exposes the same tools over the MCP stdio transport. Same compiled core (`sps-bridge`, `encrypted-store`), different wrapper.

| Component | OpenClaw path | MCP path |
|---|---|---|
| Tool registration | `openclaw.plugin.json` + plugin API | MCP `tools/list` + `tools/call` |
| Transport | OpenClaw runtime | stdio (JSON-RPC) |
| Secret store | Same `encrypted-store.mjs` | Same `encrypted-store.mjs` |
| SPS bridge | Same `sps-bridge.mjs` | Same `sps-bridge.mjs` |

### MCP server entry point

```javascript
// mcp-server.mjs — BlindPass MCP server
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server({
    name: "blindpass",
    version: "0.1.0"
}, {
    capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        { name: "request_secret", description: "...", inputSchema: { ... } },
        { name: "store_secret",   description: "...", inputSchema: { ... } },
        { name: "list_secrets",   description: "...", inputSchema: { ... } },
        { name: "delete_secret",  description: "...", inputSchema: { ... } },
    ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Same tool logic as OpenClaw plugin, shared core
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Agent-specific skill files

Each agent needs instructions that reference the MCP tools:

| File | Agent | Format |
|---|---|---|
| `SKILL.md` | OpenClaw / ClawHub | YAML frontmatter + markdown instructions |
| `AGENTS.md` | Codex / Antigravity | Markdown skill instructions |
| `CLAUDE.md` | Claude Code | Markdown (imported via `@` directive) |
| `agents/openai.yaml` | OpenAI Codex | YAML agent definition |

All files share the same core instructions but differ in:
- How to reference the tools (native plugin vs MCP)
- Installation instructions specific to each agent's config format

### Agent configuration examples

**Claude Code** (`~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "blindpass": {
      "command": "node",
      "args": ["~/.claude/skills/blindpass/dist/mcp-server.mjs"],
      "env": {
        "SPS_BASE_URL": "https://sps.blindpass.dev",
        "BLINDPASS_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Antigravity/Gemini** (`~/.gemini/settings.json`):
```json
{
  "mcpServers": {
    "blindpass": {
      "command": "node",
      "args": ["~/.gemini/skills/blindpass/dist/mcp-server.mjs"],
      "env": {
        "SPS_BASE_URL": "https://sps.blindpass.dev",
        "BLINDPASS_API_KEY": "your-api-key"
      }
    }
  }
}
```

**npm global** (any agent):
```json
{
  "mcpServers": {
    "blindpass": {
      "command": "npx",
      "args": ["-y", "@blindpass/mcp-server"]
    }
  }
}
```

### Shared core architecture

The key insight is that both the OpenClaw plugin and MCP server are **thin wrappers** around the same core:

```
┌─────────────────────────────────────────────────┐
│              Shared Core Modules                │
│                                                 │
│  sps-bridge.mjs      HPKE, JWT, SPS protocol    │
│  encrypted-store.mjs SOPS read/write/bootstrap  │
│  agent-transport.mjs Agent-to-agent exchange     │
│  blindpass-core.mjs  Tool logic (shared)         │
└───────────┬─────────────────┬───────────────────┘
            │                 │
   ┌────────▼──────┐  ┌───────▼────────┐
   │ index.mjs     │  │ mcp-server.mjs │
   │ (OpenClaw     │  │ (MCP stdio     │
   │  plugin API)  │  │  transport)    │
   └───────────────┘  └────────────────┘
```

The refactor extracts tool logic into `blindpass-core.mjs`, and both entry points call into it.

---

## 5. Distribution Strategy

### Monorepo development → distribution repo

**Decision:** Build in the `blindpass` monorepo, publish to a separate **distribution repo** (`atas-tech/blindpass-skill`).

This is the proven `dependency-guard` model:

| Repo | Purpose | Contents |
|---|---|---|
| `atas-tech/blindpass` | Development monorepo | Source code, tests, SPS server, browser UI |
| `atas-tech/blindpass-skill` | Distribution repo | Compiled bundles, skill files, installer |

### Distribution repo structure

```
atas-tech/blindpass-skill/
├── SKILL.md                        ← OpenClaw / ClawHub
├── AGENTS.md                       ← Codex / Antigravity
├── CLAUDE.md                       ← Claude Code
├── agents/
│   └── openai.yaml                 ← OpenAI Codex agent definition
├── openclaw.plugin.json            ← OpenClaw manifest
├── dist/
│   ├── blindpass.mjs               ← compiled OpenClaw plugin
│   ├── mcp-server.mjs              ← compiled MCP server
│   └── blindpass-resolver.mjs      ← compiled exec provider
├── scripts/
│   └── install_skill.sh            ← multi-agent installer
├── package.json                    ← npm publish config
├── LICENSE
└── README.md
```

### Build & publish pipeline

CI in the monorepo builds and pushes to the dist repo:

```
atas-tech/blindpass (monorepo)
│
│  npm run build:skill
│  ├── esbuild → dist/blindpass.mjs
│  ├── esbuild → dist/mcp-server.mjs
│  ├── esbuild → dist/blindpass-resolver.mjs
│  └── copy SKILL.md, AGENTS.md, CLAUDE.md, agents/, scripts/
│
│  scripts/publish_dist.sh
│  ├── git push → atas-tech/blindpass-skill
│  ├── clawhub publish
│  └── npm publish @blindpass/mcp-server
│
▼

atas-tech/blindpass-skill (dist repo)
```

### All installation paths

```bash
# ClawHub (OpenClaw users)
openclaw skills install blindpass

# npm (any agent, global)
npm install -g @blindpass/mcp-server

# Git clone + install (any agent, workspace)
git clone https://github.com/atas-tech/blindpass-skill.git
./blindpass-skill/scripts/install_skill.sh --mode project --agent all

# Git clone + install (Claude Code, global)
./scripts/install_skill.sh --mode global --agent claude

# Git clone + install (Antigravity, global)
./scripts/install_skill.sh --mode global --agent antigravity

# Git clone + install (Codex, global)
./scripts/install_skill.sh --mode global --agent codex

# npx (zero-install MCP, any agent)
npx @blindpass/mcp-server
```

---

## 6. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                     AGENT INTEGRATION LAYER                          │
│                                                                      │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  OpenClaw       │  │  Claude Code │  │  Codex / Antigravity    │  │
│  │  (native plugin)│  │  (MCP stdio) │  │  (MCP stdio)            │  │
│  └───────┬────────┘  └──────┬───────┘  └────────────┬─────────── ┘  │
│          │                  │                       │                │
│          ▼                  ▼                       ▼                │
│  ┌──────────────┐  ┌────────────────┐                                │
│  │ blindpass.mjs │  │ mcp-server.mjs │   (thin wrappers)             │
│  │ (plugin API)  │  │ (MCP transport)│                                │
│  └──────┬───────┘  └───────┬────────┘                                │
│         └─────────┬────────┘                                         │
│                   ▼                                                  │
│  ┌─────────────────────────────────┐                                 │
│  │       blindpass-core.mjs        │  (shared tool logic)            │
│  │  request_secret | store_secret  │                                 │
│  │  list_secrets   | delete_secret │                                 │
│  └────────┬──────────────┬─────────┘                                 │
│           │              │                                           │
│  ┌────────▼─────┐  ┌─────▼───────────┐                               │
│  │ sps-bridge   │  │ encrypted-store │                               │
│  │ (HPKE, JWT)  │  │ (SOPS r/w)      │                               │
│  └────────┬─────┘  └─────┬───────────┘                               │
│           │              │                                           │
│           ▼              ▼                                           │
│  ┌──────────────┐  ┌─────────────────────┐                           │
│  │  SPS Server   │  │  SOPS Store         │                          │
│  │  (hosted or   │  │  secrets.enc.json   │ (per-gateway/per-agent)  │
│  │   self-host)  │  │  .sops.yaml         │                          │
│  └──────────────┘  └─────────────────────┘                           │
│                              ▲                                       │
│                              │ reads (activation / reload)           │
│                    ┌─────────┴───────────┐                           │
│                    │ blindpass-resolver   │  (exec provider CLI)     │
│                    │ stdin → SOPS decrypt │                          │
│                    │ → stdout JSON        │                          │
│                    └─────────────────────┘                           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 7. Implementation Phases

### Phase 1: Core refactor & build system (~2 days)

| Task | Effort |
|---|---|
| Extract shared tool logic into `blindpass-core.mjs` | M |
| Set up esbuild bundle pipeline (3 entry points) | M |
| Create `scripts/build_bundle.sh` | M |
| Update `SKILL.md` frontmatter with ClawHub metadata | S |
| Prepare `package.json` for npm publish (`@blindpass/mcp-server`) | S |
| Security validation in publish pipeline | S |

### Phase 2: SOPS-backed encrypted store (~3 days)

| Task | Effort |
|---|---|
| Implement `encrypted-store.mjs` module (SOPS read/write) | M |
| Auto-bootstrap: generate age key via Node crypto + `.sops.yaml` | M |
| Graceful degradation: detect SOPS → fallback to in-memory | S |
| Modify `persistSecret()` with `BLINDPASS_AUTO_PERSIST` flag | S |
| Add `store_secret`, `list_secrets`, `delete_secret` tools | M |
| Unit tests for SOPS store module | M |
| Metadata-only audit logging (provision/rotation events) | S |

### Phase 3: BlindPass exec resolver (~2 days)

| Task | Effort |
|---|---|
| Create `blindpass-resolver` CLI entry point | M |
| Implement exec protocol v1 (stdin/stdout JSON) | S |
| Handle batch resolution (multiple IDs per call) | S |
| Error handling + timeout support | S |
| Add `bin` field to `package.json` for npm global install | S |
| Integration test with `openclaw secrets audit --allow-exec` | M |

### Phase 4: MCP server & multi-agent support (~2 days)

| Task | Effort |
|---|---|
| Create `mcp-server.mjs` wrapping `blindpass-core.mjs` | M |
| Wire MCP `tools/list` + `tools/call` handlers | S |
| Create `AGENTS.md` (Codex / Antigravity instructions) | S |
| Create `CLAUDE.md` (Claude Code instructions) | S |
| Create `agents/openai.yaml` (OpenAI agent definition) | S |
| Test MCP server with Claude Code and Antigravity | M |

### Phase 5: Distribution & end-to-end integration (~2 days)

| Task | Effort |
|---|---|
| Create `scripts/install_skill.sh` (multi-agent installer) | M |
| Create `scripts/publish_clawhub.sh` with version sync | M |
| Create `scripts/publish_dist.sh` (push to dist repo) | M |
| Set up `atas-tech/blindpass-skill` dist repo | S |
| Full lifecycle test: provision → SOPS persist → restart → resolve | L |
| `openclaw secrets reload` after rotation test | M |
| Onboarding guide (per-agent setup instructions) | S |
| Optional: TTL / forced re-provision config | S |

**Total estimated effort:** ~11 days

---

## 8. Resolved Decisions

| # | Question | Decision | Rationale |
|---|---|---|---|
| Q1 | Plugin vs. Skill? | **Full compiled plugin** | Published as compiled bundle — no source-code risk, no split install confusion |
| Q2 | SPS bundling? | **SPS is separate** | SPS runs as hosted service (`sps.blindpass.dev`) or self-hosted. Plugin only needs the URL |
| Q3 | npm too? | **Yes, dual publish** | `openclaw skills install blindpass` + `npm install -g @blindpass/mcp-server` |
| Q4 | Encryption? | **SOPS** | Built-in OpenClaw support, multiple KMS backends, widely adopted |
| Q5 | Store location? | **Follow gateway config, configurable** | Default: `<gateway-config-dir>/blindpass/`. Override via env var or `--store` flag |
| Q6 | Pre-provision UX? | **Minimal — only `BLINDPASS_API_KEY`** | Plugin defaults to hosted SPS. Users only need the bootstrap API key |
| Q7 | Auto-persist on rotation? | **Yes by default, configurable** | `BLINDPASS_AUTO_PERSIST=true` (default). Disable with `false` for memory-only |
| Q8 | Multi-gateway? | **Per-gateway store** | Each gateway has its own config dir → its own SOPS store. No shared-state conflicts |
| Q9 | Multi-agent? | **MCP server** | Standalone MCP server wrapping same core. Works with Codex, Claude, Antigravity |
| Q10 | Repo split? | **Monorepo dev → dist repo publish** | Build in `atas-tech/blindpass`, publish compiled to `atas-tech/blindpass-skill` |
| Q11 | Git install? | **Yes, via dist repo** | `git clone atas-tech/blindpass-skill` + `install_skill.sh` |

---

## 9. Additional Considerations (All Resolved)

### 7.1 Compiled bundle dependencies ✅

**Decision:** Inline monorepo dependencies via esbuild.

The current `sps-bridge.mjs` uses dynamic imports from sibling packages:

```javascript
const identity = await import(path.join(base, "packages/gateway/dist/identity.js"));
const keyManager = await import(path.join(base, "packages/agent-skill/dist/key-manager.js"));
```

For the compiled bundle:
- Extract the specific exports used (`loadOrCreateGatewayIdentity`, `issueJwt`, `generateKeyPair`, `decrypt`, etc.)
- Bundle them into a single-file ESM output via esbuild
- Ensure the HPKE/crypto code works with `node:crypto` (no browser polyfills)
- **Test risk:** `@blindpass/agent-skill` key-manager uses `crypto.subtle` for HPKE — should bundle cleanly but needs validation

### 7.2 SOPS storage — graceful degradation ✅

**Decision:** Detect SOPS availability at runtime. If configured → use it. If not → fall back to in-memory (current behavior). Expose config for users to set up SOPS later.

Storage resolution order:

```
1. Check if SOPS store is configured & accessible
   ├── YES → read/write to SOPS-encrypted store
   │         (secrets survive restarts)
   └── NO  → fall back to in-memory Map
             (current behavior, volatile)
             Log: "[blindpass] SOPS not configured — secrets stored in memory only.
                   Configure SOPS for persistent storage: https://docs.blindpass.dev/sops"
```

SPS detection logic:
- Check for `BLINDPASS_STORE_PATH` env var → SOPS store path
- Check for `<gateway-config-dir>/blindpass/secrets.enc.json` → convention path
- Check for `sops` CLI on `PATH` → needed for encrypt/decrypt operations
- If none found → gracefully degrade to in-memory

> **Important Limitation:** The `blindpass-resolver` CLI reads exclusively from the SOPS file on disk. If the plugin falls back to in-memory storage (or `BLINDPASS_AUTO_PERSIST=false`), the `exec` provider will NOT be able to resolve those secrets for other OpenClaw gateway components. In-memory mode is strictly for immediate plugin use.

When auto-bootstrapping (user explicitly opts in via `BLINDPASS_STORE_PATH` or `BLINDPASS_AUTO_PERSIST=true`):
1. First `request_secret` call triggers store initialization
2. Plugin generates age identity → `<store>/.age-key.txt`
3. Plugin creates `.sops.yaml` → `creation_rules: [{ age: "<public-key>" }]`
4. User should be warned: **back up `.age-key.txt`** — loss means all stored secrets become unrecoverable

For advanced users:
- Reconfigure `.sops.yaml` to point to AWS KMS, GCP KMS, etc.
- Use SOPS's built-in key rotation (`sops updatekeys`)
- If already using an external secret manager (Vault, 1Password), they simply don't enable SOPS — BlindPass stays in-memory and the external manager handles persistence

### 7.3 Secret scoping ✅

**Decision:** Flat namespace per-gateway. Use descriptive names for multi-agent differentiation.

Secrets are scoped **per-gateway** (each gateway has its own store). Within a gateway, secrets are **flat-namespaced** — no per-agent scoping.

If two agents on the same gateway need different Stripe keys, use descriptive names:
- `stripe.api_key.payment-bot`
- `stripe.api_key.billing-bot`

Keeps the store simple. Per-agent namespacing can be added later if needed.

### 7.4 Audit trail ✅

**Decision:** Add metadata-only logging (never values) when secrets are provisioned or rotated.

```
<store>/audit.log
```

```json
{"ts": "2026-04-02T09:00:00Z", "event": "provision", "secret_name": "openai.api_key", "source": "request_secret"}
{"ts": "2026-04-03T15:30:00Z", "event": "rotate", "secret_name": "openai.api_key", "source": "request_secret", "re_request": true}
```

Useful for compliance without sacrificing zero-knowledge.

### 7.5 Hosted SPS ✅

**Decision:** Default to BlindPass hosted SPS at `https://sps.blindpass.dev`.

| Config | Default |
|---|---|
| `SPS_BASE_URL` | `https://sps.blindpass.dev` |
| Free tier | Rate-limited, suitable for individual use |
| Self-host | Users set `SPS_BASE_URL` to their own instance |

### 7.6 TTL / forced re-provision ✅

**Decision:** Optional, user-configurable. Phase 4 nice-to-have.

Add optional TTL metadata to stored secrets:

```json
{
  "openai.api_key": {
    "value": "sk-...",
    "provisioned_at": "2026-04-02T09:00:00Z",
    "ttl_days": 90
  }
}
```

When `blindpass-resolver` encounters an expired secret, it returns an error — forcing OpenClaw to fail-fast and the agent to re-provision.

User configures TTL via:
- Per-secret: `request_secret` with `ttl_days` param (optional)
- Global default: `BLINDPASS_DEFAULT_TTL_DAYS` env var (optional, no default = no expiry)

---

## 10. Summary of all resolved decisions

| # | Topic | Decision |
|---|---|---|
| Q1 | Plugin vs. Skill? | Full compiled plugin — no source-code risk |
| Q2 | SPS bundling? | SPS is separate (hosted `sps.blindpass.dev` or self-hosted) |
| Q3 | npm too? | Yes, dual publish: ClawHub + npm |
| Q4 | Encryption? | SOPS (built-in OpenClaw support) |
| Q5 | Store location? | Follow gateway config dir, configurable via env |
| Q6 | Pre-provision UX? | Minimal — only `BLINDPASS_API_KEY` needed |
| Q7 | Auto-persist? | Default on if SOPS configured, configurable |
| Q8 | Multi-gateway? | Per-gateway store, no shared state |
| Q9 | Multi-agent? | MCP server wrapping shared core |
| Q10 | Repo split? | Monorepo dev → dist repo publish |
| Q11 | Git install? | Yes, via dist repo + install_skill.sh |
| 9.1 | Bundle deps? | Inline via esbuild into single-file ESM |
| 9.2 | SOPS vs. in-memory? | **Graceful degradation** — SOPS if available, else in-memory fallback |
| 9.3 | Secret scoping? | Flat namespace per-gateway, descriptive names |
| 9.4 | Audit trail? | Yes — metadata-only, never values |
| 9.5 | Hosted SPS? | Yes — `sps.blindpass.dev` as default |
| 9.6 | TTL? | Optional, user-configurable, Phase 5 |

---

## References

- [OpenClaw Secrets Management](https://docs.openclaw.ai/gateway/secrets) — SecretRef contract, exec protocol, SOPS examples
- [OpenClaw SecretRef Credential Surface](https://docs.openclaw.ai/reference/secretref-credential-surface)
- [atas-tech/dependency-guard](https://github.com/atas-tech/dependency-guard) — ClawHub publishing reference
- [SOPS](https://github.com/getsops/sops) — Encrypted secrets at rest (Mozilla)
- [Age](https://github.com/FiloSottile/age) — Modern encryption CLI (default SOPS backend)
