# Repository Guidelines

## Project Structure & Module Organization
This repo is a Node.js workspace monorepo. Core code lives in `packages/`:
- `packages/sps-server`: Fastify Secret Provisioning Service (API routes, crypto, Redis/in-memory store).
- `packages/gateway`: request interception and secure link delivery logic.
- `packages/agent-skill`: agent-side key management and in-memory secret store.
- `packages/openclaw-plugin`: OpenClaw integration and runtime transport handling.
- `packages/browser-ui`: Vite-based browser page for client-side encryption.

Planning and security docs are in `docs/`, and executable demos/integration helpers are in `scripts/`.

## Build, Test, and Development Commands
- `npm install`: install workspace dependencies.
- `npm run build`: build all packages (`tsc` + Vite build where defined).
- `npm test`: run all workspace tests.
- `npm run test:e2e --workspace=packages/sps-server`: run PostgreSQL-backed E2E tests (requires `DATABASE_URL` and `SPS_PG_INTEGRATION=1`).
- `npm run dev --workspace=packages/sps-server`: run SPS server in watch mode.
- `npm run dev --workspace=packages/browser-ui`: start browser UI locally.
- `npm run test:integration`: run Redis integration test for SPS server.
- `npm run redis:up` / `npm run redis:down`: start/stop local Redis via Docker Compose.

## Coding Style & Naming Conventions
TypeScript uses `strict` mode with ESM (`NodeNext`). Follow existing file style:
- Keep imports explicit (including `.js` extension in TS local imports).
- Use `camelCase` for variables/functions, `PascalCase` for types/interfaces, `UPPER_SNAKE_CASE` for env vars.
- Prefer descriptive, kebab-case file names (for example `secret-store.ts`, `egress-filter.ts`).
- Match surrounding indentation and quote style instead of reformatting unrelated lines.

No dedicated lint script is currently enforced; use `npm run build` and `npm test` as the quality gate.

## Testing Guidelines
Most packages use Vitest with tests under each package `tests/` folder (`*.test.ts`). The OpenClaw plugin uses a Node test script (`tests/index.test.mjs`). Add or update tests with each behavior change, especially around secret handling, transport fallback, and TTL/one-time retrieval logic.

**Phase Testing Rule:** When planning or implementing a new phase or milestone, always define comprehensive End-to-End (E2E) and integration test scenarios in the corresponding test plan document within the `docs/testing/` directory (e.g., `docs/testing/Phase 3A.md`). These scenarios must be implemented alongside the feature code to ensure thorough verification.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits, e.g. `feat(browser-ui): ...`, `fix(openclaw-plugin): ...`, `docs: ...`. Keep subject lines imperative and scoped by package when relevant.

PRs should include:
- clear summary of behavior changes,
- affected package(s),
- commands run (`npm test`, targeted integration tests),
- screenshots or message samples for UI/chat-delivery changes.

## Security & Configuration Tips
Never commit plaintext secrets or `.env` files. Use environment variables (for example `SPS_HMAC_SECRET`, `SPS_BASE_URL`) for local config, and avoid logging sensitive values at any layer.
