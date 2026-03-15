import pkg from 'pg';
const { Pool } = pkg;
import { encrypt, decrypt, generateKeyPair } from "../packages/agent-skill/dist/key-manager.js";
import { AgentSecretRuntime } from "../packages/agent-skill/dist/index.js";

const DEFAULT_DATABASE_URL = "postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos";
const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const baseUrl = process.env.SPS_BASE_URL || "http://localhost:3100";
const dashboardUrl = "http://localhost:5173";

async function runDemo() {
  const mode = process.argv[2] === 'manual' ? 'manual' : 'auto';
  const secretName = mode === 'manual' ? 'restricted.secret' : 'stripe.api_key.prod';

  console.log(`🌟 Starting Enhanced A2A Demo [Mode: ${mode.toUpperCase()}]...`);
  console.log(`🔗 Target API: ${baseUrl}`);
  console.log(`📊 Target Secret: ${secretName}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  try {
    // 1. Setup: Register User & Workspace
    const email = "demo@example.com";
    const password = "Password123!";
    const workspaceSlug = "demo-space";

    console.log(`👤 Login to Dashboard: ${dashboardUrl}`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    
    console.log('👤 Preparing demo user...');
    const regRes = await fetch(`${baseUrl}/api/v2/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        workspace_slug: workspaceSlug,
        display_name: "Demo Workspace"
      })
    });
    
    let userToken, workspaceId;
    if (regRes.status === 409 || regRes.status === 400) {
        // Assume already registered, try login
        const loginRes = await fetch(`${baseUrl}/api/v2/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });
        if (!loginRes.ok) throw new Error(`Login failed: ${await loginRes.text()}`);
        const loginData = await loginRes.json();
        userToken = loginData.access_token;
        workspaceId = loginData.user.workspace_id;
        console.log('✔️  User already exists, logged in.');
    } else {
        if (!regRes.ok) throw new Error(`Registration failed: ${await regRes.text()}`);
        const regData = await regRes.json();
        userToken = regData.access_token;
        workspaceId = regData.workspace.id;
        console.log('✔️  Registered new demo user.');
    }

    // 2. Shortcut: Verify user in DB so we can enroll agents
    await pool.query('UPDATE users SET status = $1, email_verified = $2 WHERE workspace_id = $3', ['active', true, workspaceId]);
    await pool.query('UPDATE workspaces SET status = $1 WHERE id = $2', ['active', workspaceId]);

    // 3. Enroll Agents
    console.log('🤖 Enrolling Agent A and Agent B...');
    const enrollAgent = async (id, name) => {
      const res = await fetch(`${baseUrl}/api/v2/agents`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${userToken}`
        },
        body: JSON.stringify({ agent_id: id, display_name: name })
      });
      
      if (res.status === 409) {
          console.log(`📡 Agent ${id} already exists, rotating key...`);
          const rotateRes = await fetch(`${baseUrl}/api/v2/agents/${id}/rotate-key`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
              body: JSON.stringify({})
          });
          if (!rotateRes.ok) throw new Error(`Rotation failed for ${id}: ${await rotateRes.text()}`);
          return rotateRes.json();
      }
      
      if (!res.ok) throw new Error(`Enrollment failed for ${id}: ${await res.text()}`);
      return res.json();
    };

    const agentAData = await enrollAgent('agent-a', 'Primary Agent');
    const agentBData = await enrollAgent('agent-b', 'Requesting Agent');

    // Token Exchange (API Key -> JWT)
    const getAgentToken = async (agentName, apiKey) => {
      if (!apiKey) throw new Error(`No API key provided for ${agentName}`);
      
      const res = await fetch(`${baseUrl}/api/v2/agents/token`, {
        method: "POST",
        headers: { "x-agent-api-key": apiKey }
      });
      if (!res.ok) throw new Error(`Token exchange failed for ${agentName}: ${await res.text()}`);
      const data = await res.json();
      return data.access_token;
    };

    console.log('🔑 Exchanging Agent API Keys for Access Tokens...');
    const agentAToken = await getAgentToken('agent-a', agentAData.bootstrap_api_key);
    const agentBToken = await getAgentToken('agent-b', agentBData.bootstrap_api_key);

    const runtimeA = new AgentSecretRuntime({
      spsBaseUrl: baseUrl,
      gatewayBearerToken: agentAToken,
      agentId: 'agent-a'
    });

    const runtimeB = new AgentSecretRuntime({
      spsBaseUrl: baseUrl,
      gatewayBearerToken: agentBToken,
      agentId: 'agent-b'
    });

    // 4. Secret Submission to Agent A
    console.log(`🔑 Agent A: Requesting secret submission for [${secretName}]...`);
    const keyPairA = await generateKeyPair();
    const reqRes = await fetch(`${baseUrl}/api/v2/secret/request`, {
        method: "POST",
        headers: { 
            "Content-Type": "application/json",
            "Authorization": `Bearer ${agentAToken}`
        },
        body: JSON.stringify({
            description: `Demo Key for ${secretName}`,
            public_key: keyPairA.publicKey
        })
    });
    
    if (!reqRes.ok) throw new Error(`Secret request failed: ${await reqRes.text()}`);
    const { request_id, secret_url } = await reqRes.json();

    console.log(`👤 Human Flow: ${secret_url}`);
    const url = new URL(secret_url);
    const submitSig = url.searchParams.get('submit_sig');
    
    const secretValue = "sk_test_demo_key_987654321";
    const sealed = await encrypt(keyPairA.publicKey, Buffer.from(secretValue));
    
    const submitRes = await fetch(`${baseUrl}/api/v2/secret/submit/${request_id}?sig=${encodeURIComponent(submitSig)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ciphertext: sealed.ciphertext,
        enc: sealed.enc
      })
    });
    if (!submitRes.ok) throw new Error(`Submission failed: ${await submitRes.text()}`);

    console.log('📥 Agent A: Retrieving secret...');
    const retrievedRes = await fetch(`${baseUrl}/api/v2/secret/retrieve/${request_id}`, {
        headers: { "Authorization": `Bearer ${agentAToken}` }
    });
    if (!retrievedRes.ok) throw new Error(`Retrieval failed: ${await retrievedRes.text()}`);
    const retrieved = await retrievedRes.json();
    const plaintext = await decrypt(keyPairA.privateKey, retrieved.enc, retrieved.ciphertext);
    runtimeA.store.storeSecret(secretName, plaintext);
    console.log('✅ Agent A: Secret secured in-memory.');

    // 5. Agent B requests from Agent A
    console.log(`🔄 Agent B: Requesting exchange for [${secretName}]...`);
    
    if (mode === 'manual') {
        console.log('⏳ [Mode: MANUAL] Waiting for human approval in Dashboard...');
        console.log(`👉 Go to ${dashboardUrl}/inbox and APPROVE the request.`);
    }

    let currentFulfillmentToken = null;
    const deliverToken = async (token) => {
        currentFulfillmentToken = token;
        console.log('📨 [Transport] Delivery fulfillment token to Agent A');
    };

    const exchangePromise = runtimeB.requestAndStoreExchangeSecret({
        secretName,
        purpose: 'Manual demo' + (mode === 'manual' ? ' (Check Inbox!)' : ''),
        fulfillerHint: 'agent-a',
        deliverToken
    });

    // Wait for token to be "delivered"
    while (!currentFulfillmentToken) {
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('⚙️  Agent A: Fulfilling exchange...');
    await runtimeA.fulfillExchange(currentFulfillmentToken);

    console.log('📥 Agent B: Retrieving exchanged secret...');
    const result = await exchangePromise;
    
    const finalSecret = runtimeB.store.get(secretName).toString();
    console.log(`✨ Success! Agent B received: ${finalSecret}`);
    console.log(`🆔 Exchange ID: ${result.exchangeId}`);

  } catch (err) {
    console.error('💥 Demo failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runDemo();
