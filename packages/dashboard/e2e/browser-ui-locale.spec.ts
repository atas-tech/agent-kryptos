import { expect, test } from "./fixtures.js";

test.describe("Browser-UI Localization", () => {
  const browserUiUrl = "http://127.0.0.1:5175";

  test("Scenario 501: Browser Language Detection in Browser-UI", async ({ browser }) => {
    // 1. Visit with Vietnamese locale
    const contextVi = await browser.newContext({
      locale: "vi-VN",
    });
    const pageVi = await contextVi.newPage();
    
    // Using preview mode with some dummy query params to trigger metadata-free view
    await pageVi.goto(`${browserUiUrl}/?requestId=preview&metadataSig=qa&submitSig=qa`);
    
    // Verify Vietnamese text in banner
    await expect(pageVi.getByText("Quan trọng:")).toBeVisible({ timeout: 15000 });
    await expect(pageVi.getByText("Hãy kiểm tra thanh địa chỉ")).toBeVisible();
    
    // Verify title
    await expect(pageVi).toHaveTitle(/Nhập bí mật an toàn/);
    
    await contextVi.close();

    // 2. Visit with English locale
    const contextEn = await browser.newContext({
      locale: "en-US",
    });
    const pageEn = await contextEn.newPage();
    await pageEn.goto(`${browserUiUrl}/?requestId=preview&metadataSig=qa&submitSig=qa`);
    
    await expect(pageEn.getByText("Important:")).toBeVisible({ timeout: 15000 });
    await expect(pageEn).toHaveTitle(/Secure Secret Input/);
    
    await contextEn.close();
  });

  test("Scenario 502: Locale Persistence from Dashboard Origin", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.goto(browserUiUrl);
    
    // Set locale to Vietnamese in localStorage
    await page.evaluate(() => {
      localStorage.setItem("blindpass_locale", "vi");
    });
    
    // Reload to apply
    await page.reload();
    
    await expect(page.getByText("Quan trọng:")).toBeVisible({ timeout: 15000 });
    
    await context.close();
  });
});
