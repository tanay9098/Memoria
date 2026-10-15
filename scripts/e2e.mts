// Browser walk-through of the demo story from a clean browser context.
// Usage: npm run dev (in another terminal), then: npx tsx scripts/e2e.mts [outDir]
import { chromium } from "playwright-core";
import path from "node:path";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const out = process.argv[2] ?? "/tmp";
const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); // fresh context = clean browser session
const page = await ctx.newPage();
const errors: string[] = [];
const overlay = async () => page.evaluate(() => (document.querySelector("nextjs-portal")?.shadowRoot?.textContent ?? "").match(/\d+\s+Issues?/)?.[0] ?? "");
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const shot = (n: string) => page.screenshot({ path: path.join(out, `${n}.png`), fullPage: true });
const step = async (label: string, fn: () => Promise<void>) => { await fn(); console.log("ok  ", label); };

await page.goto(base);
await step("dashboard loads from FalkorDB", async () => { await page.getByText(/Round \d \/ 5/).first().waitFor(); });
await step("reset demo", async () => { await page.getByRole("button", { name: /Reset demo/ }).click(); await page.getByText("Round 0 / 5").waitFor(); await shot("1-initial"); });
const next = page.getByRole("button", { name: /Run next round|Agents working|Scenario complete/ });
for (let r = 1; r <= 4; r++) {
  await step(`run round ${r}`, async () => {
    await page.getByRole("button", { name: /Run next round/ }).click();
    await page.getByText(`Round ${r} / 5`).waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /Run next round/ }).waitFor({ timeout: 30000 }).catch(() => undefined);
  });
  if (r === 3) await shot("3-broken");
}
await step("memory inspector shows episodic memory", async () => {
  await page.getByRole("button", { name: /Farmer/ }).first().click();
  await page.getByText("Deal D-2 broken by Trader").first().click();
  await page.getByText("Provenance").waitFor();
  await page.getByText("How it influenced decisions").waitFor();
  await page.getByText(/coordinate recovery/).first().waitFor();
  await shot("4-memory-inspector");
});
await shot("4-recovered");
await step("new session", async () => { await page.getByRole("button", { name: "New session", exact: true }).click(); await page.getByText("Session 2").first().waitFor(); });
await step("round 5 (memory on)", async () => {
  await page.getByRole("button", { name: /Run next round/ }).click();
  await page.getByText("Round 5 / 5").waitFor({ timeout: 30000 });
  await page.getByText("Scenario complete").waitFor({ timeout: 30000 });
  await shot("5-final");
});
await step("compare modes", async () => { await page.getByRole("button", { name: /(Re-run|Run) comparison/ }).click(); await page.getByText("Goal met").first().waitFor({ timeout: 60000 }); await shot("6-eval"); });
await step("concurrency test", async () => { await page.getByRole("button", { name: /competing-transaction/ }).click(); await page.getByText("Competing transactions ·").waitFor({ timeout: 60000 }); await shot("7-integrity"); });
const ov = await overlay(); if (ov.trim()) { console.log("Next dev overlay shows:", ov); process.exitCode = 1; }
await browser.close();
if (errors.length) { console.log("Browser errors:\n" + errors.join("\n")); process.exit(1); }
console.log("E2E OK");
