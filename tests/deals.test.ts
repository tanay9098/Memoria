import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { closeAll } from "@/lib/falkor";
import { tools } from "@/server/tools";
import { getEvents, getWorldState, NotFoundError, ValidationError } from "@/server/world";
import { seeded, wipeSimulation } from "./helpers";

let sim: string;
beforeAll(async () => { sim = await seeded("deals"); });
afterAll(async () => { await wipeSimulation(sim); await closeAll(); });

const terms = (o: object = {}) => ({
  proposer: "farmer", counterparty: "trader", giveRes: "food", giveQty: 6, getRes: "wood", getQty: 6, deadlineRound: 9, leader: null, ...o,
}) as any;

describe("deal state machine", () => {
  it("proposed → accepted → fulfilled via validated transfers", async () => {
    const { deal } = await tools.propose_deal({ sim, actor: "farmer", terms: terms(), idemKey: "a1" });
    expect(deal.state).toBe("proposed");
    await expect(tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: deal.id, from: "farmer", qty: 6, idemKey: "x0" } }))
      .rejects.toThrow(/accepted deal/);
    expect((await tools.respond_to_deal({ sim, actor: "trader", dealId: deal.id, response: { response: "accept" }, idemKey: "a2" })).deal.state).toBe("accepted");
    await tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: deal.id, from: "farmer", qty: 6, idemKey: "a3" } });
    const r = await tools.execute_validated_action({ sim, actor: "trader", action: { kind: "TRANSFER", dealId: deal.id, from: "trader", qty: 6, idemKey: "a4" } });
    expect(r.deal?.state).toBe("fulfilled");
  });

  it("rejects illegal transitions and wrong actors", async () => {
    const { deal } = await tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveQty: 1, getQty: 1 }), idemKey: "b1" });
    await expect(tools.respond_to_deal({ sim, actor: "farmer", dealId: deal.id, response: { response: "accept" }, idemKey: "b2" })).rejects.toThrow(ValidationError);
    await tools.respond_to_deal({ sim, actor: "trader", dealId: deal.id, response: { response: "reject" }, idemKey: "b3" });
    await expect(tools.respond_to_deal({ sim, actor: "trader", dealId: deal.id, response: { response: "accept" }, idemKey: "b4" })).rejects.toThrow(/Illegal transition rejected → accepted/);
    await expect(tools.record_outcome_and_memory({ sim, dealId: deal.id, result: "broken", defaulter: "trader" })).rejects.toThrow(/Illegal transition rejected → broken/);
  });

  it("validates input shape: unknown agents, quantities, actions", async () => {
    await expect(tools.propose_deal({ sim, actor: "wizard" as any, terms: terms(), idemKey: "c1" })).rejects.toThrow(ZodError);
    await expect(tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveQty: -3 }), idemKey: "c2" })).rejects.toThrow(ZodError);
    await expect(tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveQty: 1.5 }), idemKey: "c3" })).rejects.toThrow(ZodError);
    await expect(tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "DROP_TABLE" } as any })).rejects.toThrow(ZodError);
    await expect(tools.get_world_state({ sim: "x'; MATCH (n) DETACH DELETE n //" })).rejects.toThrow(ZodError);
  });

  it("enforces prerequisites: balance, authority, missing nodes", async () => {
    await expect(tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveQty: 500 }), idemKey: "d1" })).rejects.toThrow(/only holds/);
    await expect(tools.propose_deal({ sim, actor: "trader", terms: terms(), idemKey: "d2" })).rejects.toThrow(/cannot propose a deal on behalf/);
    await expect(tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "ALLOCATE", from: "farmer", to: "trader", resource: "food", qty: 1, idemKey: "d3" } })).rejects.toThrow(/Only the Mayor/);
    await expect(tools.execute_validated_action({ sim, actor: "trader", action: { kind: "TRANSFER", dealId: "D-404", from: "trader", qty: 1, idemKey: "d4" } })).rejects.toThrow(NotFoundError);
    await expect(tools.get_world_state({ sim: "does-not-exist" })).rejects.toThrow(NotFoundError);
  });

  it("staged delivery: the follower cannot deliver ahead of the leader", async () => {
    const { deal } = await tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveRes: "tools", giveQty: 4, getRes: "wood", getQty: 8, leader: "trader" }), idemKey: "e1" });
    await tools.respond_to_deal({ sim, actor: "trader", dealId: deal.id, response: { response: "accept" }, idemKey: "e2" });
    await expect(tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: deal.id, from: "farmer", qty: 1, idemKey: "e3" } })).rejects.toThrow(/must deliver ahead/);
    await tools.execute_validated_action({ sim, actor: "trader", action: { kind: "TRANSFER", dealId: deal.id, from: "trader", qty: 4, idemKey: "e4" } });
    await expect(tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: deal.id, from: "farmer", qty: 3, idemKey: "e5" } })).rejects.toThrow(/must deliver ahead/);
    await tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: deal.id, from: "farmer", qty: 2, idemKey: "e6" } });
  });

  it("is idempotent: a retried request does not duplicate events or transfers", async () => {
    const before = (await getWorldState(sim)).agents.find((a) => a.id === "mayor")!.resources.food;
    const act = { kind: "ALLOCATE" as const, from: "mayor" as const, to: "farmer" as const, resource: "food" as const, qty: 2, idemKey: "f1" };
    const a = await tools.execute_validated_action({ sim, actor: "mayor", action: act });
    const b = await tools.execute_validated_action({ sim, actor: "mayor", action: act });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect((await getWorldState(sim)).agents.find((a) => a.id === "mayor")!.resources.food).toBe(before - 2);
    const p1 = await tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveQty: 1, getQty: 1 }), idemKey: "f2" });
    const p2 = await tools.propose_deal({ sim, actor: "farmer", terms: terms({ giveQty: 1, getQty: 1 }), idemKey: "f2" });
    expect(p2.replayed).toBe(true);
    expect(p2.deal.id).toBe(p1.deal.id);
  });

  it("records backend rejections as non-state events", async () => {
    await tools.execute_validated_action({ sim, actor: "mayor", action: { kind: "ALLOCATE", from: "mayor", to: "farmer", resource: "food", qty: 999, idemKey: "g1" } }).catch(() => undefined);
    const ev = await getEvents(sim, { limit: 5 });
    expect(ev.some((e) => e.type === "ACTION_REJECTED" && e.category === "suggestion")).toBe(true);
  });
});
