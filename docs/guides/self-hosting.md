# Self-Hosting

This guide covers the supported self-hosted path for BlindPass from source. For the packaged Unraid deployment path, use [Unraid.md](/home/hvo/Projects/blindpass/docs/deployment/Unraid.md).

## Deployment shapes

- Source-based local or VM deployment:
  Run `packages/sps-server`, `packages/dashboard`, and `packages/browser-ui` from this repository and back them with PostgreSQL and Redis.
- Packaged container deployment:
  Use the GHCR images and the deployment templates documented in [Unraid.md](/home/hvo/Projects/blindpass/docs/deployment/Unraid.md).

## What you need

- Node.js 22+
- npm 10+
- Docker Engine with Compose for PostgreSQL and Redis
- A reverse proxy and TLS terminator for any public deployment

## 1. Install and configure

```bash
npm install
cp .env.example .env
```

Review `.env` before the first boot.

At minimum, set real values for:

- `SPS_HMAC_SECRET`
- `SPS_USER_JWT_SECRET`
- `SPS_AGENT_JWT_SECRET`
- `DATABASE_URL`
- `REDIS_URL`
- `SPS_UI_BASE_URL`
- `SPS_CORS_ALLOWED_ORIGINS`

For hosted-style cookie auth behind a reverse proxy, also set:

- `SPS_HOSTED_MODE=1`
- `SPS_TRUST_PROXY=1`
- `SPS_AUTH_COOKIE_DOMAIN`

## 2. Start PostgreSQL and Redis

```bash
make up
```

The standard integration harness is [docker-compose.test.yml](/home/hvo/Projects/blindpass/docker-compose.test.yml).

## 3. Run database migrations

Load the environment in your shell, then migrate:

```bash
set -a
source .env
set +a
make migrate
```

## 4. Start the services

Source deployment:

```bash
make dev-sps
```

```bash
make dev-dashboard
```

```bash
make dev-browser
```

Container deployment:

- build and publish the images from [/.github/workflows/build-and-push-images.yml](/home/hvo/Projects/blindpass/.github/workflows/build-and-push-images.yml)
- deploy them with your platform-specific tooling

## 5. Public routing model

Recommended split:

- `sps.example.com` -> SPS API
- `app.example.com` -> Dashboard
- `secret.example.com` -> Browser UI

The browser-facing origins in `SPS_CORS_ALLOWED_ORIGINS` must include the dashboard and browser UI origins.

## 6. Auth and agent bootstrap choices

Recommended default:

- enroll agents through the dashboard or hosted API
- distribute only the returned `ak_` bootstrap API keys to agents
- let agents mint short-lived bearer tokens through `POST /api/v2/agents/token`

Use `SPS_AGENT_AUTH_PROVIDERS_JSON` only if you also need SPS to trust external workload JWT issuers.

## 7. Policy configuration

Two valid models exist:

- Hosted-style per-workspace management:
  Keep `SPS_HOSTED_MODE=1` and manage the secret registry and exchange policy through the dashboard/API.
- Self-hosted bootstrap/default policy:
  Set `SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` in the environment to seed a default policy model.

See [policy.md](/home/hvo/Projects/blindpass/docs/guides/policy.md) for the document format and operational model.

## 8. Health checks

Use these endpoints from your reverse proxy or orchestrator:

- `GET /healthz`
- `GET /readyz`

`/readyz` returns `503` when PostgreSQL or Redis is unavailable.

## 9. Operational commands

```bash
make logs
```

```bash
make build
```

```bash
make test
```

```bash
make down
```

## Production notes

- Do not use `SPS_USE_IN_MEMORY=1` in production.
- Do not expose Redis directly to the internet.
- Terminate TLS before the dashboard or browser UI are used publicly.
- Configure `SPS_TURNSTILE_SECRET` and `VITE_TURNSTILE_SITE_KEY` for hosted registration/login abuse protection.
- Keep Stripe and x402 credentials out of the repository and rotate them independently of app deploys.
