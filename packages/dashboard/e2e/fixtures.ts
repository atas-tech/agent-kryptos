import { test as base } from "@playwright/test";
import pg from "pg";

const DB_URL = process.env.DATABASE_URL || "postgresql://blindpass:localdev@127.0.0.1:5433/blindpass";

export const test = base.extend<{ db: pg.Pool }>({
  db: async ({}, use) => {
    const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
    await use(pool);
    await pool.end();
  }
});

export { expect } from "@playwright/test";
