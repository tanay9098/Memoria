import { afterAll, describe, expect, it } from "vitest";
import { closeAll } from "@/lib/falkor";
import { runNextRound, startNewSession } from "@/server/scenario";
import { checkIntegrity } from "@/server/integrity";
import { getEvents, getWorldState } from "@/server/world";
import { LlmClient } from "@/server/llm";
import { playTo, seeded, wipeSimulation } from "./helpers";

const sims: string[] = [];
afterAll(async () => { for (const s of sims) await wipeSimulation(s); await closeAll(); });
const mk = async (p: string) => { const s = await seeded(p); sims.push(s); return s; };

describe("signature scenario", () => {
  it("memory ON: Farmer retrieves the broken deal, counters with staged delivery, goal met", async () => {
    const sim = await mk("on");
    await playTo(sim, 5, true);
    const w = await getWorldState(sim);
    expect(w.deals.filter((d) => d.state === "broken").map((d) => d.id)).toEqual(["D-2"]);
    expect(w.deals.find((d) => d.id === "D-5")).toMatchObject({ state: "fulfilled", leader: "trader", parentDealId: "D-4" });
    expect(w.deals.find((d) => d.id === "D-4")!.state).toBe("countered");
    expect(w.needs.villageWoodGap).toBe(0);
    expect((await checkIntegrity(sim)).ok).toBe(true);
  });

  it("memory OFF: same state, no retrieval → accepts the unsecured offer and is burned again", async () => {
    const sim = await mk("off");
    await playTo(sim, 5, false);
    const w = await getWorldState(sim);
    expect(w.deals.filter((d) => d.state === "broken").map((d) => d.id)).toEqual(["D-2", "D-4"]);
    expect(w.needs.villageWoodGap).toBe(8);
    expect((await checkIntegrity(sim)).ok).toBe(true); // lost goods, but the books still balance
    const ev = await getEvents(sim, { limit: 200 });
    expect(ev.some((e) => e.type === "MEMORY_RETRIEVED" && e.outcome === "disabled")).toBe(true);
  });

  it("does not auto-reject the Trader: a small trade is accepted even with memory on", async () => {
    const { SCENARIOS } = await import("@/server/scenario");
    const sim = await mk("low");
    const low = SCENARIOS.find((s) => s.id === "low-risk")!;
    for (let r = 1; r <= 4; r++) await runNextRound(sim, { memoryEnabled: true }, low);
    await startNewSession(sim);
    await runNextRound(sim, { memoryEnabled: true }, low);
    const w = await getWorldState(sim);
    expect(w.deals.find((d) => d.id === "D-4")!.state).toBe("fulfilled");
  });

  it("round counter and retry: a failing round is rolled back and can be rerun without duplicates", async () => {
    const sim = await mk("retry");
    await playTo(sim, 4);
    const boom: LlmClient = { choose: async () => { throw new Error("boom"); } };
    await startNewSession(sim);
    await runNextRound(sim, { memoryEnabled: true, llm: boom });
    expect((await getWorldState(sim)).sim.round).toBe(5);
    await expect(runNextRound(sim, { memoryEnabled: true })).rejects.toThrow(/Scenario complete/);
  });
});

describe("LLM failure handling", () => {
  const run = async (llm: LlmClient) => {
    const sim = await mk("llm");
    await playTo(sim, 4);
    await startNewSession(sim);
    await runNextRound(sim, { memoryEnabled: true, llm });
    const w = await getWorldState(sim);
    return { w, ev: await getEvents(sim, { limit: 300 }) };
  };

  it("provider error → deterministic fallback, same outcome, fallback event recorded", async () => {
    const { w, ev } = await run({ choose: async () => { throw new Error("503 upstream unavailable"); } });
    expect(ev.some((e) => e.type === "LLM_FALLBACK" && /503/.test(e.summary))).toBe(true);
    expect(w.deals.find((d) => d.id === "D-5")!.state).toBe("fulfilled");
  });

  it("malformed output → fallback", async () => {
    const { ev, w } = await run({ choose: async () => ({ nope: 1 }) });
    expect(ev.some((e) => e.type === "LLM_FALLBACK" && /malformed/.test(e.summary))).toBe(true);
    expect(w.needs.villageWoodGap).toBe(0);
  });

  it("illegal action (unsecured accept is not allowed once a procedure applies) → fallback, never executed", async () => {
    const { ev, w } = await run({ choose: async () => ({ optionId: "accept", rationale: "looks fine" }) });
    expect(ev.some((e) => e.type === "LLM_FALLBACK" && /not an allowed action/.test(e.summary))).toBe(true);
    expect(w.deals.filter((d) => d.state === "broken")).toHaveLength(1);
  });

  it("legal suggestion is applied and labelled as an LLM suggestion", async () => {
    const { ev } = await run({ choose: async () => ({ optionId: "counter_staged", rationale: "Trader broke D-2; secure it." }) });
    const s = ev.find((e) => e.type === "LLM_SUGGESTION" && e.actor === "farmer")!;
    expect(s.category).toBe("suggestion");
    expect(s.outcome).toBe("agrees_with_policy");
  });
});
