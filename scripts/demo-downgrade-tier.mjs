import pkg from 'pg';
const { Pool } = pkg;
import { processWebhookResult } from "../packages/sps-server/dist/services/billing.js";

const DEFAULT_DATABASE_URL = "postgresql://blindpass:localdev@127.0.0.1:5433/agent_blindpass";
const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

async function downgradeTier() {
  const workspaceSlug = process.argv[2];
  if (!workspaceSlug) {
    console.error('❌ Usage: node scripts/demo-downgrade-tier.mjs <workspace-slug>');
    process.exit(1);
  }

  console.log(`📉 Simulating Free Tier downgrade for workspace: ${workspaceSlug}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    // 1. Find Workspace
    const wsRes = await pool.query('SELECT id FROM workspaces WHERE slug = $1', [workspaceSlug]);
    if (wsRes.rows.length === 0) {
      throw new Error(`Workspace not found: ${workspaceSlug}`);
    }
    const workspaceId = wsRes.rows[0].id;

    // 2. Simulate Webhook Result
    console.log('📡 Injecting simulated webhook result (subscription deleted)...');
    const result = await processWebhookResult(pool, 'stripe', {
      workspaceId,
      billingPatch: {
        tier: 'free',
        subscriptionStatus: 'canceled'
      }
    });

    if (result) {
      console.log('✅ Success! Workspace downgraded to Free Tier.');
      console.log(`📊 Current Tier: ${result.tier}`);
      console.log(`🆔 Subscription Status: ${result.subscriptionStatus}`);
    } else {
      console.error('❌ Failed to process downgrade.');
    }

  } catch (err) {
    console.error('💥 Downgrade failed:', err.message);
  } finally {
    await pool.end();
  }
}

downgradeTier();
