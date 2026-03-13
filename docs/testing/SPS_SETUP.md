# SPS Server Testing Setup Guide

This document provides a comprehensive guide to setting up the Secret Provisioning Service (SPS) server for 100% testing support, including End-to-End (E2E) and Integration tests.

## 1. Environment Configuration

The SPS server relies on environment variables for its core logic. We provide a template to get you started.

1.  Navigate to `packages/sps-server/`.
2.  Copy `.env.test.example` to `.env.test`:
    ```bash
    cp .env.test.example .env.test
    ```
3.  Ensure the following critical variables are set:
    - `DATABASE_URL`: Points to your PostgreSQL instance (default `5433` for local Docker).
    - `REDIS_URL`: Points to your Redis instance (default `6380` for local Docker).
    - `SPS_USER_JWT_SECRET`: Used for signing and verifying user session tokens.
    - `SPS_HMAC_SECRET`: Used for internal request integrity.

> [!NOTE]
> `STRIPE_SECRET_KEY` and other billing variables are optional for core testing. The server will start without them in `test` or `development` mode, but billing-related routes will throw an error if accessed without valid keys.

## 2. Generating Security Secrets

For a secure testing environment, you should generate unique secrets for your `.env.test` file.

### Generate a 256-bit Secret (Base64)
You can use OpenSSL or a simple Node.js command:

**Using OpenSSL:**
```bash
openssl rand -base64 32
```

**Using Node.js:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> [!IMPORTANT]
> The `SPS_USER_JWT_SECRET` must be identical between the `sps-server` and any client that manually verifies tokens (if applicable).

## 3. Database Preparation

Before running tests, the database must be reachable and migrated to the latest schema.

1.  **Start PostgreSQL**:
    ```bash
    npm run redis:up # Starts the full Docker Compose stack including Postgres
    ```
2.  **Run Migrations**:
    ```bash
    npm run db:migrate --workspace=packages/sps-server
    ```

## 4. Verifying Connectivity

You can use the provided dev-setup script to verify that all dependencies are reachable:

```bash
node scripts/dev-setup.mjs
```

This script probes ports for Redis (`6380`) and PostgreSQL (`5433`) to ensure they are ready for the SPS server.

## 5. Running the Tests

Once configured, you can run the SPS-specific test suites:

```bash
# General Vitest suite
npm test --workspace=packages/sps-server

# Integration tests (requires running Redis/Postgres)
npm run test:integration --workspace=packages/sps-server
npm run test:e2e --workspace=packages/sps-server
```

## 6. Common Troubleshooting

- **"Failed to fetch"**: Check that `VITE_SPS_API_URL` in the Dashboard or `SPS_BASE_URL` in the server are correctly pointing to the running instances.
- **JWT Errors**: Ensure `SPS_USER_JWT_SECRET` is set and hasn't changed between the login and session verification steps.
- **Rate Limiting**: If tests fail with `429 Too Many Requests`, increase `SPS_AUTH_REGISTRATION_LIMIT` and `SPS_AUTH_LOGIN_LIMIT` in `.env.test`.
- **Validation (400 Bad Request)**: Registration requires specific formats:
    - **Password**: Minimum 8 characters.
    - **Workspace Slug**: 3-40 characters, alphanumeric and hyphens only (`^[a-z0-9-]{3,40}$`).
    - **Email**: Must be a valid email address.
