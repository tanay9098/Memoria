import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, ping } from "@/lib/falkor";
import { getAgentMemories } from "@/server/memory";
import { getWorldState, getEvents } from "@/server/world";
import { startNewSession } from "@/server/scenario";
import { playTo, seeded, wipeSimulation } from "./helpers";

let sim: string;
beforeAll(async () => {
  const p = await ping();
  if (!p.ok) throw new Error(`FalkorDB must be running for tests: ${p.error}`);
  sim = await seeded("persist");
  await playTo(sim, 3);
});
afterAll(async () => { await wipeSimulation(sim); await closeAll(); });

describe("persistent world", () => {
  it("reads balances, agents and deals from FalkorDB", async () => {
    const w = await getWorldState(sim);
    expect(w.agents.map((a) => a.id)).toEqual(["farmer", "trader", "mayor"]);
    expect(w.agents[0].resources.food).toBe(24); // 40 − 4 (D-1) − 12 (D-2)
    expect(w.deals.map((d) => `${d.id}:${d.state}`)).toEqual(["D-0:fulfilled", "D-1:fulfilled", "D-2:broken"]);
  });

  it("memory and world survive dropping every connection (fresh sockets, no in-process state)", async () => {
    await closeAll();
    const mem = await getAgentMemories(sim, "farmer");
    expect(mem.some((m) => m.kind === "episodic" && /D-2 broken/.test(m.title))).toBe(true);
    expect((await getWorldState(sim)).sim.round).toBe(3);
  });

  it("a new interaction session keeps the village and all memory", async () => {
    const before = await getAgentMemories(sim, "farmer");
    const { session } = await startNewSession(sim);
    expect(session).toBe(2);
    const after = await getAgentMemories(sim, "farmer");
    expect(after.map((m) => m.uid).sort()).toEqual(before.map((m) => m.uid).sort());
    const ev = await getEvents(sim, { limit: 1 });
    expect(ev[0].type).toBe("SESSION_STARTED");
  });

  it("scopes data per simulation: a second sim does not see the first one's memory", async () => {
    const other = await seeded("persist-other");
    try {
      const mem = await getAgentMemories(other, "farmer");
      expect(mem.some((m) => /D-2/.test(m.title))).toBe(false);
      expect((await getWorldState(other)).agents[0].resources.food).toBe(40);
    } finally { await wipeSimulation(other); }
  });
});
