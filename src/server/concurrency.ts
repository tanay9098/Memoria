// Competing-transaction tests against a limited balance, using separate FalkorDB connections.
// What this proves: FalkorDB executes each GRAPH.QUERY write atomically and one at a time per graph,
// and our queries put the balance guard, the transfer and its idempotency marker in ONE statement.
// What it does not prove: ACID semantics across multiple statements (FalkorDB has none) — multi-step
// workflows rely on keyed, idempotent steps instead.
import { q, uid } from "@/lib/falkor";
import { tools } from "./tools";
import { seedSimulation, wipeSimulation } from "./seed";
import { checkIntegrity } from "./integrity";
import { getWorldState } from "./world";

export interface ConcurrencyCase { name: string; ok: boolean; detail: string; attempts: number; accepted: number; rejected: number; replayed: number }
export interface ConcurrencyReport { ranAt: string; ok: boolean; cases: ConcurrencyCase[]; control: ConcurrencyCase; integrity: Awaited<ReturnType<typeof checkIntegrity>> }

type Outcome = "accepted" | "replayed" | "rejected";
async function settleAll(ps: Promise<any>[]): Promise<Outcome[]> {
  const res = await Promise.allSettled(ps);
  return res.map((r) => (r.status === "rejected" ? "rejected" : r.value.replayed ? "replayed" : "accepted"));
}
const count = (o: Outcome[], k: Outcome) => o.filter((x) => x === k).length;

export async function runConcurrencyTests(N = 12): Promise<ConcurrencyReport> {
  const sim = `conc-${Date.now().toString(36)}`;
  await seedSimulation(sim);
  const cases: ConcurrencyCase[] = [];
  const setBalance = (agent: string, res: string, qty: number) =>
    q(`MATCH (r:Resource {uid:$u}) SET r.qty = $qty, r.initialQty = $qty`, { u: uid(sim, `res|${agent}|${res}`), qty });
  const balance = async (agent: string, res: string) =>
    (await getWorldState(sim)).agents.find((a) => a.id === agent)!.resources[res as "food"];

  // Case 1 — N competing allocations of 8 from a balance of 10: at most one may succeed.
  await setBalance("mayor", "food", 10);
  await setBalance("farmer", "food", 0);
  const o1 = await settleAll(Array.from({ length: N }, (_, i) =>
    tools.execute_validated_action({ sim, actor: "mayor", action: { kind: "ALLOCATE", from: "mayor", to: "farmer", resource: "food", qty: 8, idemKey: `c1-${i}` } })));
  const [m1, f1] = [await balance("mayor", "food"), await balance("farmer", "food")];
  cases.push({
    name: `${N} competing transfers of 8 from a balance of 10`,
    ok: count(o1, "accepted") === 1 && m1 === 2 && f1 === 8,
    detail: `accepted=${count(o1, "accepted")}, rejected=${count(o1, "rejected")}; source ${m1}, destination ${f1} (expected exactly one transfer: 2 / 8)`,
    attempts: N, accepted: count(o1, "accepted"), rejected: count(o1, "rejected"), replayed: count(o1, "replayed"),
  });

  // Case 2 — the same logical request retried N times concurrently (same idempotency key): applied once.
  await setBalance("mayor", "wood", 20);
  await setBalance("trader", "wood", 0);
  const o2 = await settleAll(Array.from({ length: N }, () =>
    tools.execute_validated_action({ sim, actor: "mayor", action: { kind: "ALLOCATE", from: "mayor", to: "trader", resource: "wood", qty: 5, idemKey: "c2-same" } })));
  const [m2, t2] = [await balance("mayor", "wood"), await balance("trader", "wood")];
  cases.push({
    name: `${N} concurrent retries of one request (same idempotency key)`,
    ok: count(o2, "accepted") === 1 && m2 === 15 && t2 === 5,
    detail: `applied=${count(o2, "accepted")}, replayed/duplicate-suppressed=${count(o2, "replayed")}, errors=${count(o2, "rejected")}; source ${m2}, destination ${t2} (expected 15 / 5, i.e. a single transfer)`,
    attempts: N, accepted: count(o2, "accepted"), rejected: count(o2, "rejected"), replayed: count(o2, "replayed"),
  });

  // Case 3 — a deal obligation delivered twice in parallel (different keys): only one delivery counts.
  await setBalance("farmer", "tools", 5);
  await setBalance("trader", "tools", 0);
  const { deal } = await tools.propose_deal({ sim, actor: "farmer", idemKey: "c3-deal", terms: { proposer: "farmer", counterparty: "trader", giveRes: "tools", giveQty: 4, getRes: "food", getQty: 4, deadlineRound: 9, leader: null } });
  await tools.respond_to_deal({ sim, actor: "trader", dealId: deal.id, response: { response: "accept" }, idemKey: "c3-accept" });
  const o3 = await settleAll(Array.from({ length: N }, (_, i) =>
    tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: deal.id, from: "farmer", qty: 4, idemKey: `c3-${i}` } })));
  const [f3, t3] = [await balance("farmer", "tools"), await balance("trader", "tools")];
  cases.push({
    name: `${N} parallel deliveries of the same 4-tool obligation`,
    ok: count(o3, "accepted") === 1 && f3 === 1 && t3 === 4,
    detail: `accepted=${count(o3, "accepted")}, rejected=${count(o3, "rejected")}; farmer ${f3}, trader ${t3} (expected 1 / 4: no double delivery)`,
    attempts: N, accepted: count(o3, "accepted"), rejected: count(o3, "rejected"), replayed: count(o3, "replayed"),
  });

  // Case 4 — accept and reject racing on the same proposed deal: compare-and-set lets one win.
  const { deal: d4 } = await tools.propose_deal({ sim, actor: "farmer", idemKey: "c4-deal", terms: { proposer: "farmer", counterparty: "trader", giveRes: "tools", giveQty: 1, getRes: "food", getQty: 1, deadlineRound: 9, leader: null } });
  const o4 = await settleAll([
    ...Array.from({ length: N / 2 }, (_, i) => tools.respond_to_deal({ sim, actor: "trader", dealId: d4.id, response: { response: "accept" }, idemKey: `c4-a${i}` })),
    ...Array.from({ length: N / 2 }, (_, i) => tools.respond_to_deal({ sim, actor: "trader", dealId: d4.id, response: { response: "reject" }, idemKey: `c4-r${i}` })),
  ]);
  const final4 = (await getWorldState(sim)).deals.find((d) => d.id === d4.id)!;
  cases.push({
    name: `${N} racing accept/reject responses to one proposal`,
    ok: count(o4, "accepted") === 1 && (final4.state === "accepted" || final4.state === "rejected"),
    detail: `one transition won (state=${final4.state}); accepted=${count(o4, "accepted")}, rejected=${count(o4, "rejected")}`,
    attempts: N, accepted: count(o4, "accepted"), rejected: count(o4, "rejected"), replayed: count(o4, "replayed"),
  });

  const integrity = await checkIntegrity(sim);

  // Negative control (NOT part of the pass/fail): the classic check-then-act mistake, split across two
  // statements. If the harness is any good, this version overdraws the balance under the same load.
  await setBalance("mayor", "tools", 10);
  const naive = async () => {
    const [{ qty }] = await q<{ qty: number }>(`MATCH (r:Resource {uid:$u}) RETURN r.qty AS qty`, { u: uid(sim, "res|mayor|tools") });
    if (qty < 8) throw new Error("insufficient");
    await q(`MATCH (r:Resource {uid:$u}) SET r.qty = r.qty - 8`, { u: uid(sim, "res|mayor|tools") });
    return { replayed: false };
  };
  const o5 = await settleAll(Array.from({ length: N }, () => naive()));
  const after = await balance("mayor", "tools");
  const control: ConcurrencyCase = {
    name: `CONTROL: naive read-then-write, ${N} concurrent withdrawals of 8 from 10`,
    ok: after < 0 || count(o5, "accepted") > 1,   // "ok" here means: the harness DID expose the race
    detail: `${count(o5, "accepted")} withdrawals succeeded, final balance ${after} — ${after < 0 ? "overdraft exposed (this is why the real path guards inside one statement)" : "race not triggered this run"}`,
    attempts: N, accepted: count(o5, "accepted"), rejected: count(o5, "rejected"), replayed: 0,
  };
  await wipeSimulation(sim);
  return { ranAt: new Date().toISOString(), ok: cases.every((c) => c.ok) && integrity.ok, cases, control, integrity };
}
