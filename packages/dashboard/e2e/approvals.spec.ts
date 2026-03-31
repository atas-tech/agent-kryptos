import { expect, test } from "./fixtures.js";
import { setupWorkspace } from "./setup.js";

test.describe("Approvals Inbox", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("Scenario 403: Approval flow (Admin)", async ({ page, db }) => {
    // 1. Seed workspace directly into the dashboard root
    const { workspaceId } = await setupWorkspace(page, "approvals-403");
    
    // 2. Seed a pending approval event into audit_log via DB fixture
    const aprRef = `apr_${Date.now()}`;
    await db.query(`
      INSERT INTO audit_log (workspace_id, event_type, resource_id, metadata, actor_type, actor_id)
      VALUES ($1, 'exchange_approval_requested', $2, $3, 'agent', 'bot-1')
    `, [workspaceId, aprRef, JSON.stringify({
      requester_id: 'bot-1',
      fulfilled_by: 'bot-2',
      secret_name: 'e2e-secret',
      purpose: 'E2E Testing',
      policy_rule_id: 'rule-e2e'
    })]);

    // 3. Navigate to approvals via sidebar (verifies navigation link and role sync)
    await page.getByTestId("nav-link-approvals").click();
    await expect(page).toHaveURL("/approvals", { timeout: 10000 });

    // Verify approval card appears
    await expect(page.getByText("e2e-secret")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("E2E Testing")).toBeVisible();

    // Verify action buttons
    await expect(page.getByTestId("approval-approve-btn").first()).toBeEnabled();
    await expect(page.getByTestId("approval-deny-btn").first()).toBeEnabled();
  });

  test("Scenario 404: Viewer read-only access", async ({ page, db }) => {
    const { workspaceId } = await setupWorkspace(page, "approvals-404", "workspace_viewer", [], "/approvals");
    
    // Viewers should see the read-only note
    await expect(page.getByTestId("viewer-read-only-note")).toBeVisible();
    
    // Seed an approval to verify buttons are disabled for viewers
    const aprRef = `apr_viewer_${Date.now()}`;
    await db.query(`
      INSERT INTO audit_log (workspace_id, event_type, resource_id, metadata, actor_type, actor_id)
      VALUES ($1, 'exchange_approval_requested', $2, $3, 'agent', 'bot-1')
    `, [workspaceId, aprRef, JSON.stringify({ secret_name: 'viewer-test' })]);
    
    await page.reload();
    await expect(page.getByText("viewer-test")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("approval-approve-btn").first()).toBeDisabled();
    await expect(page.getByTestId("approval-deny-btn").first()).toBeDisabled();
  });
});
