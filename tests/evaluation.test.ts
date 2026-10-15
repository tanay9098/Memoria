import { afterAll, describe, expect, it } from "vitest";
import { closeAll } from "@/lib/falkor";
import { runEvaluation, latestEvaluation } from "@/server/evaluation";

afterAll(async () => { await closeAll(); });

describe("memory ON vs OFF evaluation", () => {
  it("memory mode retrieves the historical deal and avoids the repeat failure; books stay valid in both modes", async () => {
    const r = await runEvaluation();
    expect(r.summary.memory).toEqual({ runs: 3, retrieved: 3, matched: 3, avoided: 3, goal: 3, valid: 3 });
    expect(r.summary["no-memory"].retrieved).toBe(0);
    expect(r.summary["no-memory"].goal).toBe(1);   // only the low-risk control succeeds
    expect(r.summary["no-memory"].valid).toBe(3);
    expect((await latestEvaluation())?.ranAt).toBe(r.ranAt);
  });
});
