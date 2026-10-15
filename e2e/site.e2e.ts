import { expect, test } from "@playwright/test";

test("/about tells the story with the real note and plays both sides", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const res = await page.goto("/about");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("remember what Maa asked");
  await expect(page.getByRole("button", { name: /Original/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Kept/ })).toBeVisible();
  const srcs = await page.locator("audio").evaluateAll((els) => els.map((e) => (e as HTMLAudioElement).getAttribute("src")));
  expect(srcs.length).toBe(2);
  for (const src of srcs) expect((await request.get(src as string)).status()).toBe(200);
  const og = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(og).toMatch(/^https:\/\/.+\/landing\/media\/og-about\.png\?v=[0-9a-f]{8}$/);
  expect((await request.get(new URL(og as string).pathname)).status()).toBe(200);
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("/pitch is a 10-slide deck that moves with the arrow keys", async ({ page }) => {
  const res = await page.goto("/pitch");
  expect(res?.status()).toBe(200);
  await expect(page.locator("section.slide")).toHaveCount(10);
  await expect(page.locator("section.slide.on")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/#2$/);
  await page.keyboard.press("End");
  await expect(page).toHaveURL(/#10$/);
});

test("the app's nav reaches the story page", async ({ page }) => {
  await page.goto("/judge");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
});
