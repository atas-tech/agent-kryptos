# Agent-Kryptos (Agent Secrets)

Agent-Kryptos is a secure, zero-knowledge secret provisioning system designed to let humans and AI agents exchange sensitive credentials through one coordinating SPS server without exposing plaintext to the LLM or the server.

This repository contains the architecture, implementation plans, and source code for the Secret Provisioning System (SPS), including gateway-level anti-phishing, in-memory-only secret storage, and HPKE (Hybrid Public Key Encryption) encryption.

## Table of Contents
- [Overview](#overview)
- [Architecture](#architecture)
- [Directory Structure](#directory-structure)
- [Documentation](#documentation)
- [Features](#features)
- [Getting Started](#getting-started)

## Overview

When an AI Agent needs a secret to complete a task (e.g., "Deploy my website to AWS"), it should **never ask for the secret in plain text over chat**, nor should the secret ever be visible to the LLM.

Agent-Kryptos solves this by using SPS as the trust anchor and coordinator. For Human -> Agent flow, the gateway generates a secure, single-use, out-of-band link for the user. The user encrypts the secret in their browser, and only the agent's constrained execution environment can decrypt and hold it in memory. For Agent -> Agent flow, SPS coordinates a pull-based exchange between stable agent identities, enforcing policy, approvals, and one-time retrieval without requiring Kubernetes or a cluster control plane.

## Architecture

The system consists of 4 main components:
1. **SPS Server:** A Fastify backend with Redis-backed storage for handling encrypted payload submission and retrieval. All data has a strict TTL.
2. **Browser UI:** A zero-dependency, static HTML/JS page served to the user. It handles client-side HPKE encryption so the plaintext secret never traverses the network.
3. **Agent Skill:** A package that gives agents the `request_secret` tool, handles keypair generation, and securely manages the in-memory `SecretStore`.
4. **Gateway Middleware / Runtime Integration:** Intercepts LLM tool calls, replaces them with secure out-of-band links, enforces outbound URL filtering, and can mint or forward SPS-trusted agent tokens for coordinated agent-to-agent exchange.

## Directory Structure

```text
agent-kryptos/
├── docs/                 # System architecture, security audits, and test plans
│   ├── architecture/     # Implementation plans and system design docs
│   ├── plugins/          # Telegram and other plugin integration plans
│   ├── security/         # Security audit documentation
│   └── testing/          # E2E and component test plans
├── packages/             # Monorepo packages (TypeScript)
│   ├── agent-skill/      # Agent-side secret management skill
│   ├── browser-ui/       # Secure client-side encryption interface
│   ├── gateway/          # Gateway security middleware
│   ├── openclaw-plugin/  # OpenClaw specific integration
│   └── sps-server/       # Secret Provisioning Service backend
└── scripts/              # Integration tests and E2E demonstration scripts
```

## Documentation

Detailed documentation and planning can be found in the `docs/` folder:
- [Implementation Plan](docs/architecture/Implementation%20Plan.md)
- [Secure Secret Input Service Design](docs/architecture/Secure%20Secret%20Input%20Service%20Design.txt)
- [Security Audit](docs/security/Security%20Audit.md)
- [Telegram Plugin Plan](docs/plugins/Implementation%20Plan%20-%20Plugin%20-%20Telegram.md)

## Features

- **Zero-Knowledge Encryption:** Secrets are encrypted in the user's browser using HPKE before transmission. The server only sees ciphertext.
- **Short-Lived Keys:** Agent keypairs and encrypted payloads are ephemeral and strictly TTL-bound.
- **Phishing Prevention:** Gateway egress filtering redacts unexpected URLs, and requests are protected by cryptographically secure confirmation codes.
- **Atomic Single-Use Retrieval:** Secrets are retrieved and deleted atomically via Redis Lua scripts, ensuring they can only be read once.
- **No LLM Exposure:** The LLM orchestration layer never comes in contact with plaintext secrets.
- **Single Coordinator Model:** One SPS server can coordinate secret exchange across multiple agents and hosts using stable agent IDs and SPS-trusted JWT/JWKS validation.

## Getting Started

*(Instructions for local development and deployment to be added as implementation progresses)*
