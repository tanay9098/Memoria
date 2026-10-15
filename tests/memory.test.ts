import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, ro } from "@/lib/falkor";
import { getAgentMemories, recordOutcomeAndMemory } from "@/server/memory";
import { runNextRound, startNewSession } from "@/server/scenario";
import { checkIntegrity } from "@/server/integrity";
import { getWorldState } from "@/server/world";
import { playTo, seeded, wipeSimulation } from "./helpers";

let sim: string;
beforeAll(async () => { sim = await seeded("mem"); await playTo(sim, 3); });
afterAll(async () => { await wipeSimulation(sim); await closeAll(); });

describe("three memory types after the broken deal", () => {
  it("episodic: what happened, linked to deal, event and evidence", async () => {
    const mems = await getAgentMemories(sim, "farmer", { kinds: ["episodic"] });
    const m = mems.find((x) => x.dealId === "D-2")!;
    expect(m.epistemic).toBe("observed");
    expect(m.content).toMatch(/failed to deliver the outstanding 8 wood/);
    expect(m.eventUid).toMatch(/outcome:D-2:broken/);
    expect(m.evidence).toHaveLength(1);
    expect(m.evidence[0].summary).toMatch(/delivered 0 of 8/);
    expect(m.subjects).toContain("trader");
  });

  it("semantic: reliability belief drops by the documented rule, with update history and evidence", async () => {
    const [k] = (await getAgentMemories(sim, "farmer", { kinds: ["semantic"], about: "trader" }));
    expect(k.epistemic).toBe("inferred");
    expect(k.value).toBe(0.43);
    expect(k.revisions.map((r) => [r.from, r.to])).toEqual([[0.5, 0.67], [0.67, 0.75], [0.75, 0.43]]);
    expect(k.evidence.map((e) => e.summary).join(" ")).toMatch(/delivered 0 of 8/);
    expect(k.content).toMatch(/inference from evidence, not a fact/);
  });

  it("procedural: lesson is only 'proposed' — not claimed as learned until an outcome validates it", async () => {
    const procs = await getAgentMemories(sim, "farmer", { kinds: ["procedural"] });
    const lesson = procs.find((p) => p.params?.partner === "trader")!;
    expect(lesson.status).toBe("proposed");
    expect(lesson.epistemic).toBe("suggested");
    expect(lesson.stats).toEqual({ successCount: 0, failureCount: 0 });
    expect(lesson.eventUid).toMatch(/outcome:D-2:broken/);
    expect(procs.find((p) => p.params?.partner === "*")!.status).toBe("predefined");
  });

  it("the Trader remembers its own default, and the Mayor observed it", async () => {
    expect((await getAgentMemories(sim, "trader", { kinds: ["episodic"] })).some((m) => /^I broke deal D-2/.test(m.title))).toBe(true);
    expect((await getAgentMemories(sim, "mayor", { kinds: ["episodic"] })).some((m) => /D-2 broken by Trader/.test(m.title))).toBe(true);
  });

  it("recording the same outcome again is a no-op (no duplicate memories, revisions or events)", async () => {
    const count = async () => (await ro(`MATCH (n {sim:$sim}) RETURN count(n) AS c`, { sim }))[0].c as number;
    const before = await count();
    const r = await recordOutcomeAndMemory(sim, { dealId: "D-2", result: "broken", defaulter: "trader" });
    expect(r.replayed).toBe(true);
    expect(await count()).toBe(before);
  });
});

describe("later decision uses memory, then outcome evaluation promotes the procedure", () => {
  it("rounds 4–5: staged counter fulfilled → lesson status proposed → supported (only after the outcome)", async () => {
    await runNextRound(sim, { memoryEnabled: true }); // 4
    await expect(runNextRound(sim, { memoryEnabled: true })).rejects.toThrow(/Begin a new session first/);
    await startNewSession(sim);
    await runNextRound(sim, { memoryEnabled: true }); // 5
    const procs = await getAgentMemories(sim, "farmer", { kinds: ["procedural"] });
    const lesson = procs.find((p) => p.params?.partner === "trader")!;
    expect(lesson.status).toBe("supported");
    expect(lesson.stats?.successCount).toBe(1);
    expect(lesson.influenced.some((d) => d.action === "counter_staged" && d.sessionNo === 2)).toBe(true);
    const w = await getWorldState(sim);
    expect(w.needs.villageWoodGap).toBe(0);
    expect((await checkIntegrity(sim)).ok).toBe(true);
  });
});
