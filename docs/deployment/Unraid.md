# Unraid Deployment

This guide covers the current deployment path for running Agent Kryptos on Unraid using the Unraid Docker UI and images published to GitHub Container Registry.

## What gets deployed

- `ghcr.io/tuthan/agent-kryptos-sps-server`
- `ghcr.io/tuthan/agent-kryptos-browser-ui`
- `redis:7-alpine`

The Unraid templates for these containers are in:

- [`deploy/unraid/agent-kryptos-redis.xml`](/home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-redis.xml)
- [`deploy/unraid/agent-kryptos-sps-server.xml`](/home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-sps-server.xml)
- [`deploy/unraid/agent-kryptos-browser-ui.xml`](/home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-browser-ui.xml)

The template `Repository` fields currently point at `ghcr.io/tuthan/...`.
If you publish the images under a different GitHub owner or organization, edit the `Repository` value in the Unraid UI before deploying.

## Before you deploy

1. Publish the images manually from GitHub Actions.
   The workflow is manual-only in [`/.github/workflows/build-and-push-images.yml`](/home/hvo/Projects/agent-kryptos/.github/workflows/build-and-push-images.yml).

2. Set the repository variable `VITE_SPS_API_URL` in GitHub before building the UI image.
   Example: `https://sps.example.com`

3. Decide whether the GHCR packages will be public or private.
   Public packages are simpler on Unraid.
   Private packages require GHCR credentials on the Unraid side.

4. Prepare public DNS and TLS.
   Recommended split:
   - `https://sps.example.com` for the SPS API
   - `https://secrets.example.com` for the browser UI

## If your GHCR packages are private

You need a GitHub personal access token with `read:packages`.

Use that token in Unraid when authenticating to `ghcr.io`.

Recommended values:

- Registry: `ghcr.io`
- Username: your GitHub username
- Password: your GitHub personal access token

## Unraid Docker UI steps

1. Create a custom Docker network in Unraid.
   Use a name such as `agent-kryptos`.

2. Add the Redis template.
   Use [`deploy/unraid/agent-kryptos-redis.xml`](/home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-redis.xml).
   In the Unraid Docker UI, use the template URL or copy the XML into your templates directory.

3. Add the SPS template.
   Use [`deploy/unraid/agent-kryptos-sps-server.xml`](/home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-sps-server.xml).

4. Add the Browser UI template.
   Use [`deploy/unraid/agent-kryptos-browser-ui.xml`](/home/hvo/Projects/agent-kryptos/deploy/unraid/agent-kryptos-browser-ui.xml).

5. For Redis and SPS, set the network to the same custom network.
   The default `REDIS_URL` in the template assumes the Redis container name is `agent-kryptos-redis`.

6. Fill in the SPS template values:
   - `SPS_HMAC_SECRET`: required, strong random value
   - `SPS_UI_BASE_URL`: your public browser UI URL
   - `SPS_GATEWAY_JWKS_URL`: preferred if you can expose JWKS from the gateway
   - `SPS_GATEWAY_JWKS_FILE`: use only if you plan to mount a local file

7. If you use `SPS_GATEWAY_JWKS_FILE`, place the file on Unraid first.
   Recommended host path:
   - `/mnt/user/appdata/agent-kryptos/jwks.json`

8. Deploy the containers.

## Reverse proxy

Put a reverse proxy in front of the UI and API.

Typical Unraid choices:

- Nginx Proxy Manager
- Traefik
- Caddy

Recommended upstreams:

- `secrets.example.com` -> `http://<unraid-host>:8080`
- `sps.example.com` -> `http://<unraid-host>:3100`

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

- `SPS_BASE_URL=https://sps.example.com`
- `SPS_UI_BASE_URL=https://secrets.example.com`

## Troubleshooting

If the SPS container starts but generated links are wrong:

- check `SPS_UI_BASE_URL`
- check the reverse proxy hostnames

If the browser UI loads but cannot talk to the API:

- check the `VITE_SPS_API_URL` value used when the UI image was built
- rebuild and redeploy the UI image if needed

If the SPS container cannot validate gateway tokens:

- check `SPS_GATEWAY_JWKS_URL`
- or confirm the mounted `jwks.json` file exists and matches `SPS_GATEWAY_JWKS_FILE`

If the SPS container cannot reach Redis:

- make sure Redis and SPS are on the same custom Docker network
- confirm `REDIS_URL=redis://agent-kryptos-redis:6379`
