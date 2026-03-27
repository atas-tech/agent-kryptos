# Unraid Deployment

This guide covers the current deployment path for running BlindPass on Unraid using the Unraid Docker UI and images published to GitHub Container Registry.

This is the simplest deployment shape for the project: one SPS server, one browser UI sandbox, one operator dashboard, and Redis. Kubernetes is not required.

## What gets deployed

- `ghcr.io/tuthan/blindpass-sps-server`
- `ghcr.io/tuthan/blindpass-browser-ui`
- `ghcr.io/tuthan/blindpass-dashboard`
- `redis:7-alpine`

The Unraid templates for these containers are in:

- [`deploy/unraid/blindpass-redis.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-redis.xml)
- [`deploy/unraid/blindpass-sps-server.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-sps-server.xml)
- [`deploy/unraid/blindpass-browser-ui.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-browser-ui.xml)
- [`deploy/unraid/blindpass-dashboard.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-dashboard.xml)

The template `Repository` fields currently point at `ghcr.io/tuthan/...`.
If you publish the images under a different GitHub owner or organization, edit the `Repository` value in the Unraid UI before deploying.

## Before you deploy

1. Publish the images manually from GitHub Actions.
   The workflow is manual-only in [`/.github/workflows/build-and-push-images.yml`](/home/hvo/Projects/blindpass/.github/workflows/build-and-push-images.yml).

2. The hosted GitHub Actions workflow now bakes `VITE_SPS_API_URL=https://sps.atas.tech` into the published browser UI and dashboard images.
   If you are self-hosting under a different API domain, build your own images or adjust the workflow before publishing.

3. Decide whether the GHCR packages will be public or private.
   Public packages are simpler on Unraid.
   Private packages require GHCR credentials on the Unraid side.

4. Prepare public DNS and TLS.
   Recommended split:
   - `https://sps.atas.tech` for the SPS API
   - `https://secret.atas.tech` for the browser UI sandbox
   - `https://app.atas.tech` for the operator dashboard

## If your GHCR packages are private

You need a GitHub personal access token with `read:packages`.

Use that token in Unraid when authenticating to `ghcr.io`.

Recommended values:

- Registry: `ghcr.io`
- Username: your GitHub username
- Password: your GitHub personal access token

## Unraid Docker UI steps

1. Create a custom Docker network in Unraid.
   Use a name such as `blindpass`.

2. Add the Redis template.
   Use [`deploy/unraid/blindpass-redis.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-redis.xml).
   In the Unraid Docker UI, use the template URL or copy the XML into your templates directory.

3. Add the SPS template.
   Use [`deploy/unraid/blindpass-sps-server.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-sps-server.xml).

4. Add the Browser UI template.
   Use [`deploy/unraid/blindpass-browser-ui.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-browser-ui.xml).

5. Add the Dashboard template.
   Use [`deploy/unraid/blindpass-dashboard.xml`](/home/hvo/Projects/blindpass/deploy/unraid/blindpass-dashboard.xml).

6. For Redis and SPS, set the network to the same custom network.
   The default `REDIS_URL` in the template assumes the Redis container name is `blindpass-redis`.

7. Fill in the SPS template values:
   - `SPS_HMAC_SECRET`: required, strong random value
   - `SPS_UI_BASE_URL`: your public browser UI URL, for example `https://secret.atas.tech`
   - `SPS_CORS_ALLOWED_ORIGINS`: comma-separated browser origins allowed to call the SPS API. Include every deployed first-party frontend origin, for example `https://app.atas.tech,https://secret.atas.tech`
   - `SPS_AUTH_MAX_ACTIVE_SESSIONS`: optional cap on concurrent active refresh sessions per user. Defaults to `10`
   - `SPS_HOSTED_MODE=1`: enables hosted workspace and dashboard flows
   - `SPS_AUTH_COOKIE_DOMAIN`: hosted cookie domain, for example `.atas.tech`
   - `SPS_TURNSTILE_SECRET`: optional Cloudflare Turnstile secret for hosted login and registration protection
   - `SPS_TRUST_PROXY=1`: required when SPS sits behind a reverse proxy that terminates TLS
   - `SPS_AGENT_AUTH_PROVIDERS_JSON`: Optional for hosted/API-key-only deployments. Use this only when SPS must trust self-hosted or external workload JWT issuers via `{name, issuer, audience, jwks_url/jwks_file, require_spiffe}`. This replaces the legacy `SPS_GATEWAY_JWKS_URL` and `SPS_GATEWAY_JWKS_FILE` variables.
   - `SPS_EXCHANGE_POLICY_JSON`: optional JSON array defining Agent-to-Agent exchange policies for self-hosted bootstrap/default configuration.
   - `SPS_SECRET_REGISTRY_JSON`: optional JSON array defining known secrets and their classifications for self-hosted bootstrap/default configuration.
   - `BILLING_PORTAL_RETURN_URL`: optional hosted dashboard billing return URL, typically `https://app.atas.tech/billing`

   Preferred auth path:
   - Hosted agents and local OpenClaw/plugin installs should use agent API keys and `POST /api/v2/agents/token`.
   - Configure `BLINDPASS_API_KEY` (or `SPS_AGENT_API_KEY`) on the agent/plugin side after enrollment.
   - Add `SPS_AGENT_AUTH_PROVIDERS_JSON` only if you also want SPS to accept self-hosted workload JWTs or enforce stronger workload identity controls such as SPIFFE-backed providers.

   Example `SPS_AGENT_AUTH_PROVIDERS_JSON`:

   ```json
   [
     {
       "name": "gateway-main",
       "issuer": "agent-gateway",
       "audience": "sps",
       "jwks_url": "https://gateway.example.com/.well-known/jwks.json"
     }
   ]
   ```

    Add more providers only if you actually have multiple workload issuers to trust.
    Skip this setting entirely if you are using hosted agent API keys only.

   Policy configuration note:
   - In self-hosted single-tenant deployments, `SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` are still valid as startup configuration.
   - In the hosted Phase 3E model, these env vars are not the per-workspace control plane. Workspace admins manage secret registry and exchange policy through the hosted dashboard/API, and SPS resolves policy by `workspace_id`.

8. If you use `jwks_file` in your JSON config, place the file on Unraid first.
   Recommended host path:
   - `/mnt/user/appdata/blindpass/jwks.json`

   Note: a bridge or helper may still write a local `jwks.json` for convenience, but SPS only reads it when that file is referenced from `SPS_AGENT_AUTH_PROVIDERS_JSON`.

9. Deploy the containers.

## Reverse proxy

Put a reverse proxy in front of the UI and API.

Typical Unraid choices:

- Nginx Proxy Manager
- Traefik
- Caddy

Recommended upstreams:

- `secret.atas.tech` -> `http://<unraid-host>:8080`
- `app.atas.tech` -> `http://<unraid-host>:8081`
- `sps.atas.tech` -> `http://<unraid-host>:3100`

Do not expose Redis to the internet.

## Important behavior of the browser UI image

The browser UI image is built with `VITE_SPS_API_URL` baked into the bundle at build time.

That means:

- if your API URL changes, rerun the manual GitHub Actions workflow
- publish a new UI image
- redeploy the Browser UI container in Unraid

## After deployment

Point the rest of your system to the new SPS API URL.

Examples:

- `SPS_BASE_URL=https://sps.atas.tech`
- `SPS_UI_BASE_URL=https://secret.atas.tech`
- `SPS_CORS_ALLOWED_ORIGINS=https://app.atas.tech,https://secret.atas.tech`

## Troubleshooting

If the SPS container starts but generated links are wrong:

- check `SPS_UI_BASE_URL`
- check the reverse proxy hostnames

If the browser UI loads but cannot talk to the API:

- check the `VITE_SPS_API_URL` value used when the browser UI or dashboard image was built
- check `SPS_CORS_ALLOWED_ORIGINS` includes the calling frontend origin
- rebuild and redeploy the affected frontend image if needed

If the SPS container cannot validate gateway tokens:

- validate the `SPS_AGENT_AUTH_PROVIDERS_JSON` structure and confirm each `issuer`, `audience`, and reachability of `jwks_url` or path to `jwks_file`.

If the SPS container cannot reach Redis:

- make sure Redis and SPS are on the same custom Docker network
- confirm `REDIS_URL=redis://blindpass-redis:6379`

## Hosted vs self-hosted policy configuration

Use `SPS_SECRET_REGISTRY_JSON` and `SPS_EXCHANGE_POLICY_JSON` only as bootstrap/default inputs for a self-hosted or single-tenant deployment.

In hosted mode, these env vars are not the primary control plane. Workspace admins manage policy through the dashboard and hosted API, and SPS resolves the active policy by `workspace_id`.
