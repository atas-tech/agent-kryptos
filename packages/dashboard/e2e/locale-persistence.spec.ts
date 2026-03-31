import { expect, test } from "./fixtures.js";

test.describe("Locale Persistence & Switching", () => {
  test("Scenario 401: Default Locale and Manual Switch", async ({ page }) => {
    // 1. Visit login - should be English by default
    await page.goto("/login");
    
    // Check for English text using the data-testid
    const submitBtn = page.getByTestId("login-submit");
    await expect(submitBtn).toContainText(/Sign in/i, { timeout: 15000 });
    
    // Switch to VI via data-testid dropdown
    const localeSelect = page.getByTestId("locale-select");
    await expect(localeSelect).toBeVisible({ timeout: 15000 });
    await expect(localeSelect).toContainText("EN");
    
    await localeSelect.click();
    const viOption = page.getByTestId("locale-option-vi");
    await expect(viOption).toBeVisible();
    await viOption.click();
    
    // Check if the selector now shows VI
    await expect(localeSelect).toContainText("VI");
    
    // Reload and check persistence
    await page.reload();
    await expect(page.getByTestId("locale-select")).toContainText("VI", { timeout: 15000 });
    
    // Switch back to EN
    await localeSelect.click();
    await page.getByTestId("locale-option-en").click();
    await expect(localeSelect).toContainText("EN");
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
