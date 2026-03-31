import pg from "pg";

const DB_URL = process.env.DATABASE_URL || "postgresql://blindpass:localdev@127.0.0.1:5433/blindpass";

export default async function globalSetup() {
  const client = new pg.Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query("SELECT 1");
    console.log("[E2E globalSetup] PostgreSQL is reachable.");
  } catch (err) {
    throw new Error(
      `[E2E Pre-flight FAILED] Cannot connect to PostgreSQL at ${DB_URL}.\n` +
      `Ensure Docker is running: docker compose -f docker-compose.test.yml up -d\n` +
      `Original error: ${err instanceof Error ? err.message : err}`
    );
  } finally {
    await client.end();
  }
}
