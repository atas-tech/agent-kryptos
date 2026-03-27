# Quick Start

This guide gets a local BlindPass stack to the point where you can register a workspace, enroll agents, and run a first secret-exchange demo from a clean machine.

## Prerequisites

- Node.js 22+
- npm 10+
- Docker Engine with Compose

## 1. Install dependencies

```bash
npm install
```

## 2. Prepare local configuration

```bash
cp .env.example .env
set -a
source .env
set +a
```

The defaults target:

- SPS API at `http://127.0.0.1:3100`
- Dashboard at `http://127.0.0.1:5173`
- Browser UI at `http://127.0.0.1:5175`
- PostgreSQL at `127.0.0.1:5433`
- Redis at `127.0.0.1:6380`

## 3. Start local infrastructure

```bash
make up
make migrate
```

## 4. Start the apps

Run these in separate terminals with the same environment loaded:

```bash
make dev-sps
```

```bash
make dev-dashboard
```

```bash
make dev-browser
```

## 5. Create a workspace in the dashboard

Open `http://127.0.0.1:5173`.

1. Register a new workspace admin account.
2. Use a unique workspace slug.
3. Complete email verification if you enabled production-like verification behavior.

For fast local development, the default non-production setup logs verification guidance instead of requiring a real mail system.

## 6. Enroll agents

In the dashboard:

1. Open the Agents page.
2. Enroll your requester and fulfiller agents.
3. Copy the returned `bootstrap_api_key` values.

Those API keys are exchanged for short-lived SPS agent bearer tokens through `POST /api/v2/agents/token`.

## 7. Run the first end-to-end exchange demo

Build the packages once so the demo scripts can import the compiled workspace packages:

```bash
npm run build
```

Then run the automated local A2A demo:

```bash
node scripts/demo-a2a.mjs auto
```

What the demo does:

- provisions its own demo workspace and demo agents for a reproducible smoke test
- registers or logs into a local workspace
- verifies the local owner record for demo purposes
- enrolls `agent-a` and `agent-b`
- submits a secret to `agent-a`
- requests an exchange from `agent-b`
- fulfills and retrieves the secret through SPS

If you want a manual human-in-the-loop browser submission instead, use:

```bash
npm run e2e:human
```

## 8. Useful follow-ups

- Policy editing guide: [policy.md](/home/hvo/Projects/blindpass/docs/guides/policy.md)
- Self-hosting guide: [self-hosting.md](/home/hvo/Projects/blindpass/docs/guides/self-hosting.md)
- API reference: [docs/api/README.md](/home/hvo/Projects/blindpass/docs/api/README.md)
- Unraid deployment: [Unraid.md](/home/hvo/Projects/blindpass/docs/deployment/Unraid.md)

## Shutdown

```bash
make down
```
