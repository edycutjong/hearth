import { expect, test } from "@playwright/test";

test("the judge page opens with no account and no credentials", async ({ page }) => {
  await page.goto("/judge");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Proof" }).first()).toBeAttached();
});

test("proof page lists what ran", async ({ page }) => {
  await page.goto("/proof");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What actually ran.");
});

test("no page scrolls sideways at 375 px", async ({ page }) => {
  for (const path of ["/", "/judge", "/proof"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("without Nebius credentials the app points to the sample instead of failing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open the judge sample" })).toBeVisible();
});

test("a missing page says so", async ({ page }) => {
  const res = await page.goto("/no-such-page");
  expect(res?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Nothing kept here.");
});
