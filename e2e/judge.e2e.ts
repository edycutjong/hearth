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

test("on a phone the site nav still reaches the judge sample and the proof", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/proof");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Judge sample" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Proof" })).toBeVisible();
});

test("the word the judge page suggests finds its segment in the sample", async ({ page }) => {
  await page.goto("/judge");
  const step = page.locator("ol.steps li").nth(2);
  const word = /“([^”]+)”/.exec((await step.textContent()) ?? "")?.[1];
  expect(word, "step 3 names a word to search").toBeTruthy();
  await page.getByRole("searchbox", { name: "Search the notes" }).fill(word as string);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.locator("button.seg.match").first()).toBeVisible();
});

test("both sides of the A/B are served", async ({ page, request }) => {
  await page.goto("/judge");
  const srcs = await page.locator("audio").evaluateAll((els) => els.map((e) => (e as HTMLAudioElement).getAttribute("src")));
  expect(srcs.length).toBe(2);
  for (const src of srcs) expect((await request.get(src as string)).status()).toBe(200);
});

test("/judge answers a bare request: 200, no redirect, honest FLEURS framing, no cookie required", async ({ request }) => {
  const res = await request.get("/judge", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("FLEURS read speech, not a family note");
  expect(html).toMatch(/Hear .*of voice kept in/);
});

test("/api/proof is public and carries the sample Job records", async ({ request }) => {
  const res = await request.get("/api/proof", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty("deployed");
  expect(Array.isArray(body.sample.jobs)).toBe(true);
});
