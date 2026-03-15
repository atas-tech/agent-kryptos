# Manual Test & Demo Guide

This guide describes how to manually demonstrate and test the human-in-the-loop flows (Inbox & Approvals) and Tier Management.

## 1. Inbox & Approval Flow

This flow triggers when an exchange request requires human intervention according to the policy.

### Prerequisites
- Start the infrastructure: `npm run redis:up`
- Start the server: `npm run dev --workspace=packages/sps-server`
- Configure a policy that requires approval in `.env.test`:
  ```json
  SPS_EXCHANGE_POLICY_JSON='[{"ruleId": "require-human", "secretName": "restricted.secret", "mode": "pending_approval"}]'
  ```

### Steps
1. **Setup Workspace & Request**: Run the demo script in manual mode:
   `node scripts/demo-a2a.mjs manual`
2. **Dashboard Approval**:
   - The script will print login credentials (Email: `demo@example.com`, Password: `Password123!`).
   - Open the Dashboard at `http://localhost:5173`.
   - Log in and go to the **Inbox** tab.
   - You should see the request for `restricted.secret`.
3. **Approve**:
   - Click **Approve**.
   - The script, which is polling in the terminal, will detect the approval and complete the exchange automatically.

---

### Changing Workspace Tiers
You can instantly toggle a workspace's tier for testing using these simulators:

- **Upgrade to Standard**:
  ```bash
  node scripts/demo-upgrade-tier.mjs <your-workspace-slug>
  ```

- **Downgrade to Free**:
  ```bash
  node scripts/demo-downgrade-tier.mjs <your-workspace-slug>
  ```

Verify the change by refreshing the Dashboard:
- **Free Tier**: Lower limits (Agents, Members, Exchanges).
- **Standard Tier**: Higher service quotas.

---

## 3. x402 Autonomous Payments (Base Sepolia)

### Demonstration
1. **Setup Allowance**:
   - In the Dashboard, go to **Agents**.
   - Select an agent and set an **x402 Monthly Allowance** (e.g., $1.00).
2. **Trigger Overages**:
   - Use `scripts/demo-x402.mjs`.
   - This script exhausts the free slots and then performs a paid request.
3. **Audit Trails**:
   - Go to the **Audit Log** in the Dashboard.
   - Observe the `x402_payment_verified` and `x402_payment_settled` events.
   - Go to **Billing > Transactions** to see the ledger entry with the Base Sepolia Transaction Hash.

---

## Utility Scripts Summary

| Script | Purpose |
| --- | --- |
| `scripts/db-reset.mjs` | Full clean start (Drops schema & Re-migrates) |
| `scripts/demo-a2a.mjs` | End-to-end Agent-to-Agent flow on real servers |
| `scripts/demo-x402.mjs` | x402 Payment flow demonstration (Base Sepolia) |
| `scripts/demo-upgrade-tier.mjs` | Instantly upgrade a workspace to Standard Tier |
| `scripts/demo-downgrade-tier.mjs` | Instantly downgrade a workspace to Free Tier |
