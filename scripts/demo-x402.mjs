import http from 'node:http';
import pkg from 'pg';
const { Pool } = pkg;
import { AgentSecretRuntime } from "../packages/agent-skill/dist/index.js";

const DEFAULT_DATABASE_URL = "postgresql://blindpass:localdev@127.0.0.1:5433/blindpass";
const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const baseUrl = process.env.SPS_BASE_URL || "http://localhost:3100";
const facilitatorPort = 3102;

// 1. Mock Facilitator
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/verify' || req.url === '/settle')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log(`📡 [Facilitator] Received ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/verify') {
        res.end(JSON.stringify({ valid: true, scheme: "exact", networkId: "eip155:84532", payer: "demo-agent" }));
      } else {
        res.end(JSON.stringify({ status: "settled", txHash: "0x" + "a".repeat(64) }));
      }
    });
  } else {
    res.writeHead(404).end();
  }
});

async function runDemo() {
  console.log('💎 Starting x402 Base Sepolia Demo...');

  server.listen(facilitatorPort, () => {
    console.log(`📡 [Facilitator] Running on port ${facilitatorPort}`);
  });

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    // Setup Workspace & User
    const regRes = await fetch(`${baseUrl}/api/v2/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `x402-${Date.now()}@example.com`,
        password: "Password123!",
        workspace_slug: `x402-space-${Date.now()}`,
        display_name: "x402 Demo Workspace"
      })
    });
    const { access_token: userToken, workspace } = await regRes.json();
    const workspaceId = workspace.id;

    await pool.query('UPDATE users SET status = $1, email_verified = $2 WHERE workspace_id = $3', ['active', true, workspaceId]);
    await pool.query('UPDATE workspaces SET status = $1 WHERE id = $2', ['active', workspaceId]);

    // Enroll Agent
    const agentRes = await fetch(`${baseUrl}/api/v2/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
      body: JSON.stringify({ agent_id: 'payment-bot', display_name: 'Payment Bot' })
    });

    if (!agentRes.ok) {
        const errorData = await agentRes.json();
        throw new Error(`Enrollment failed for agent-bot: ${JSON.stringify(errorData)}`);
    }

    const agentData = await agentRes.json();
    if (!agentData.agent) {
        throw new Error(`Unexpected enrollment response structure: ${JSON.stringify(agentData)}`);
    }
    const agentId = agentData.agent.agent_id;

    // Token Exchange (API Key -> JWT)
    console.log('🔑 Exchanging Agent API Key for Access Token...');
    const tokenRes = await fetch(`${baseUrl}/api/v2/agents/token`, {
      method: "POST",
      headers: { "x-agent-api-key": agentData.bootstrap_api_key }
    });
    const { access_token: agentToken } = await tokenRes.json();

    // Set Agent Allowance (Budget) - Required for x402
    console.log('💰 Setting agent allowance (budget: 50 cents)...');
    await fetch(`${baseUrl}/api/v2/billing/allowances`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
      body: JSON.stringify({ agent_id: agentId, monthly_budget_cents: 50 })
    });

    // Exhaust free slots (Default is 10)
    console.log('📉 Exhausting free exchange slots (Simulated)...');
    await pool.query(
      "INSERT INTO workspace_exchange_usage (workspace_id, usage_month, free_exchange_used, updated_at) VALUES ($1, date_trunc('month', now() AT TIME ZONE 'UTC'), $2, now()) ON CONFLICT (workspace_id, usage_month) DO UPDATE SET free_exchange_used = EXCLUDED.free_exchange_used",
      [workspaceId, 10]
    );

    // Setup Agent Runtime with x402 Payment Provider
    const runtime = new AgentSecretRuntime({
      spsBaseUrl: baseUrl,
      gatewayBearerToken: agentToken,
      agentId: agentId,
      x402PaymentProvider: {
        createPayment: async ({ paymentIdentifier, paymentRequired }) => {
          console.log(`💳 [Agent] Protocol 402 Required for ${paymentIdentifier}`);
          console.log(`📊 [Agent] Quoted Amount: ${paymentRequired.metadata.quoted_asset_amount} ${paymentRequired.metadata.quoted_asset_symbol}`);
          console.log(`🌐 [Agent] Network: ${paymentRequired.accepts[0].network} (Base Sepolia)`);

          return Buffer.from(JSON.stringify({
            x402Version: 2,
            paymentId: paymentIdentifier,
            scheme: "exact",
            network: paymentRequired.accepts[0].network,
            amount: paymentRequired.accepts[0].maxAmountRequired,
            resource: paymentRequired.accepts[0].resource,
            payer: `agent:${agentId}`,
            signature: "demo-signature-verified-by-mock-facilitator"
          })).toString('base64');
        }
      }
    });

    // Make an exchange request that triggers 402
    console.log('🔄 Requesting exchange (should trigger x402)...');
    try {
      await runtime.requestAndStoreExchangeSecret({
        secretName: 'stripe.api_key.prod',
        purpose: 'Overage demo',
        fulfillerHint: 'fulfiller-not-needed-for-402-trigger',
        deliverToken: async () => { } // Not needed for the 402 part of the flow
      });
    } catch (e) {
      if (e.message.includes('402')) {
        console.log('✅ x402 Flow Triggered and Handled by Provider.');
      } else if (e.message.includes('fulfiller')) {
        console.log('✅ x402 Flow Succeeded (Failed later due to fulfiller missing, which is expected).');
      } else {
        console.warn('⚠️ Unexpected error:', e.message);
      }
    }

    // Verify Ledger
    console.log('📜 Checking x402 Transaction Ledger...');
    const ledgerRes = await fetch(`${baseUrl}/api/v2/billing/x402/transactions`, {
      headers: { "Authorization": `Bearer ${userToken}` }
    });
    const { transactions } = await ledgerRes.json();

    if (transactions.length > 0) {
      const tx = transactions[0];
      console.log(`✨ Success! Transaction recorded:`);
      console.log(`   - Payment ID: ${tx.payment_id}`);
      console.log(`   - Status: ${tx.status}`);
      console.log(`   - Network: ${tx.network_id}`);
      console.log(`   - Amount: ${tx.quoted_asset_amount} USDC`);
    } else {
      console.error('❌ No transactions found in ledger.');
    }

  } catch (err) {
    console.error('💥 x402 Demo failed:', err);
  } finally {
    await pool.end();
    server.close();
    console.log('👋 Demo closed.');
  }
}

runDemo();
