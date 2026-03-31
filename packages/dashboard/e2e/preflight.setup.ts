import { test, expect } from "@playwright/test";
import pg from "pg";

const DB_URL = process.env.DATABASE_URL || "postgresql://blindpass:localdev@127.0.0.1:5433/blindpass";
const E2E_SEED_TOKEN = process.env.SPS_E2E_SEED_TOKEN ?? "blindpass-e2e-seed-token";

test("Pre-flight: Database state", async () => {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    // 1. Verify migrations are applied (SPS auto-migrates on startup)
    const migrationCheck = await client.query(
      "SELECT COUNT(*)::int AS count FROM information_schema.tables " +
      "WHERE table_schema = 'public' AND table_name = '_migrations'"
    );
    expect(
      migrationCheck.rows[0].count,
      "_migrations table not found — SPS server may not have started correctly"
    ).toBeGreaterThan(0);

    const appliedCount = await client.query("SELECT COUNT(*)::int AS count FROM _migrations");
    if (appliedCount.rows[0].count < 17) {
      console.warn(
        `[E2E Pre-flight WARNING] Only ${appliedCount.rows[0].count}/17 migrations applied.`
      );
    }

    // 2. Truncate all data tables for a clean slate
    await client.query(`
      TRUNCATE
        users, workspaces, user_sessions, user_tokens,
        audit_log, enrolled_agents, agent_allowances,
        workspace_policy_documents, workspace_exchange_usage, public_offers,
        x402_transactions, x402_inflight, guest_payments, guest_intents
      CASCADE
    `);
    console.log("[E2E preflight] Database truncated successfully.");
  } finally {
    await client.end();
  }
});

test("Pre-flight: Server readiness", async ({ request }) => {
  // 1. SPS server health
  const health = await request.get("http://127.0.0.1:3100/healthz");
  expect(health.ok(), "SPS /healthz failed — server did not start").toBeTruthy();

  // 2. Seed route is available (proves the E2E-only guards are enabled)
  const seed = await request.post("http://127.0.0.1:3100/api/v2/auth/test/seed-workspace", {
    headers: {
      "x-blindpass-e2e-seed-token": E2E_SEED_TOKEN
    },
    data: { prefix: "preflight" }
  });
  expect(
    seed.status(),
    `Seed route returned ${seed.status()} — SPS may be missing NODE_ENV=test, ` +
    `SPS_ENABLE_TEST_SEED_ROUTES=1, or a matching SPS_E2E_SEED_TOKEN. ` +
    `Kill stale processes: lsof -ti :3100 | xargs kill -9`
  ).toBe(201);

  // 3. Dashboard Vite server
  const dashboard = await request.get("http://127.0.0.1:5173/");
  expect(dashboard.ok(), "Dashboard (port 5173) not responding").toBeTruthy();

  // 4. Browser-UI Vite server
  const browserUi = await request.get("http://127.0.0.1:5175/");
  expect(browserUi.ok(), "Browser-UI (port 5175) not responding").toBeTruthy();
});
