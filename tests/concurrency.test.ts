import { afterAll, describe, expect, it } from "vitest";
import { closeAll } from "@/lib/falkor";
import { runConcurrencyTests } from "@/server/concurrency";

afterAll(async () => { await closeAll(); });

describe("competing transactions", () => {
  it("never overdraw, double-deliver or double-apply a retried request", async () => {
    const r = await runConcurrencyTests(12);
    for (const c of r.cases) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    expect(r.integrity.ok).toBe(true);
  });

  it("the harness is sensitive: a naive read-then-write control does overdraw", async () => {
    const r = await runConcurrencyTests(12);
    expect(r.control.ok, r.control.detail).toBe(true);
  });
});
