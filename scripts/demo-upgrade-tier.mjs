import pkg from 'pg';
const { Pool } = pkg;
import { processWebhookResult } from "../packages/sps-server/dist/services/billing.js";

const DEFAULT_DATABASE_URL = "postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos";
const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;

async function upgradeTier() {
  const workspaceSlug = process.argv[2];
  if (!workspaceSlug) {
    console.error('❌ Usage: node scripts/demo-upgrade-tier.mjs <workspace-slug>');
    process.exit(1);
  }

  console.log(`🚀 Simulating Standard Tier upgrade for workspace: ${workspaceSlug}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    // 1. Find Workspace
    const wsRes = await pool.query('SELECT id FROM workspaces WHERE slug = $1', [workspaceSlug]);
    if (wsRes.rows.length === 0) {
      throw new Error(`Workspace not found: ${workspaceSlug}`);
    }
    const workspaceId = wsRes.rows[0].id;

    // 2. Simulate Webhook Result
    console.log('📡 Injecting simulated webhook result...');
    const result = await processWebhookResult(pool, 'stripe', {
      workspaceId,
      billingPatch: {
        tier: 'standard',
        customerId: `sim_cus_${Date.now()}`,
        subscriptionId: `sim_sub_${Date.now()}`,
        subscriptionStatus: 'active'
      }
    });

    if (result) {
      console.log('✅ Success! Workspace upgraded to Standard Tier.');
      console.log(`📊 Current Tier: ${result.tier}`);
      console.log(`🆔 Subscription ID: ${result.providerSubscriptionId}`);
    } else {
      console.error('❌ Failed to process upgrade.');
    }

  } catch (err) {
    console.error('💥 Upgrade failed:', err.message);
  } finally {
    await pool.end();
  }
}

upgradeTier();
