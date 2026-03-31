import { expect, test } from "./fixtures.js";

test.describe("Locale Persistence & Switching", () => {
  test("Scenario 401: Default Locale and Manual Switch", async ({ page }) => {
    // 1. Visit login - should be English by default
    await page.goto("/login");
    
    // Check for English text using the data-testid
    const submitBtn = page.getByTestId("login-submit");
    await expect(submitBtn).toContainText(/Sign in/i, { timeout: 15000 });
    
    // Switch to VI via data-testid
    const viLabel = page.getByTestId("locale-label-vi");
    await expect(viLabel).toBeVisible({ timeout: 15000 });
    
    const viToggle = page.getByTestId("locale-toggle-vi");
    await viToggle.check({ force: true });
    
    // Check if the toggle is checked
    await expect(viToggle).toBeChecked();
    
    // Reload and check persistence
    await page.reload();
    await expect(page.getByTestId("locale-toggle-vi")).toBeChecked({ timeout: 15000 });
    
    // Switch back to EN
    await page.getByTestId("locale-toggle-en").check({ force: true });
    await expect(page.getByTestId("locale-toggle-en")).toBeChecked();
  });

  test("Scenario 402: Browser Language Detection", async ({ browser }) => {
    // Create a new context with Vietnamese as the preferred language
    const context = await browser.newContext({
      locale: "vi-VN",
    });
    const page = await context.newPage();
    
    await page.goto("/login");
    
    // Should auto-detect Vietnamese if no localStorage exists
    const submitBtn = page.getByTestId("login-submit");
    await expect(submitBtn).toContainText("Đăng nhập", { timeout: 15000 });
    
    await context.close();
  });
});
