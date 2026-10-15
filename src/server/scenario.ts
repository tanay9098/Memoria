// The scripted "Broken Deal" scenario. Rounds are deterministic; every state change goes through
// the validated tools, every step carries an idempotency key, so a round can be safely retried.
import { q, ro, uid } from "@/lib/falkor";
import { AgentId, ResourceType, dealValue } from "@/lib/domain";
import { tools } from "./tools";
import { recordEvent } from "./events";
import { applyOfferDecision, decideOffer, decideProposal, executeDeal, retrieve, RunOpts, sleep } from "./agents";
import { recordDecision, recordOutcomeAndMemory } from "./memory";
import { traderOffer } from "./policy";
import { completeTask } from "./tasks";
import { getDeal, getWorldState, NotFoundError, requireSim, setAgentStatus, simUid, ValidationError } from "./world";
import { nm } from "./deals";

export interface ScenarioConfig {
  id: string; title: string;
  give: { res: ResourceType; qty: number };   // what the Farmer would hand over
  get: { res: ResourceType; qty: number };    // what the Trader offers
  woodNeed: number;
  expected: "counter_staged" | "accept";
}
export const SCENARIOS: ScenarioConfig[] = [
  { id: "tools-for-wood", title: "Unsecured 4 tools ⇄ 8 wood (exposure 8)", give: { res: "tools", qty: 4 }, get: { res: "wood", qty: 8 }, woodNeed: 26, expected: "counter_staged" },
  { id: "edge-case", title: "Unsecured 3 tools ⇄ 6 wood (exposure 6)", give: { res: "tools", qty: 3 }, get: { res: "wood", qty: 6 }, woodNeed: 24, expected: "counter_staged" },
  { id: "low-risk", title: "Small trade 1 tool ⇄ 2 wood (exposure 2)", give: { res: "tools", qty: 1 }, get: { res: "wood", qty: 2 }, woodNeed: 20, expected: "accept" },
];
export const DEFAULT_SCENARIO = SCENARIOS[0];

/** Scripted adversary: the Trader defaults on unsecured deals where the Farmer prepays ≥ 6 in value. */
export const traderDefaults = (exposureValue: number, secured: boolean) => !secured && exposureValue >= 6;

export const ROUND_TITLES: Record<number, string> = {
  1: "Successful trade (D-1)",
  2: "Unsecured big deal (D-2)",
  3: "Scripted event: Trader fails to deliver",
  4: "Recovery plan: Farmer → Mayor → Trader",
  5: "Related negotiation (new session)",
};

// ------------------------------------------------------------------ session handling

export async function startNewSession(sim: string): Promise<{ session: number }> {
  await requireSim(sim);
  const rows = await q(
    `MATCH (s:Simulation {uid:$su})
     SET s.session = s.session + 1
     CREATE (se:Session {uid: s.id + '|session|' + toString(s.session), sim:$sim, n:s.session, startedAt:$ts,
       label:'Session ' + toString(s.session)})
     CREATE (s)-[:HAS_SESSION]->(se)
     RETURN s.session AS session`,
    { su: simUid(sim), sim, ts: new Date().toISOString() },
  );
  const session = rows[0].session as number;
  await recordEvent(sim, {
    key: `session:${session}`, type: "SESSION_STARTED", actor: "system", outcome: "confirmed",
    summary: `Session ${session} started — chat transcript cleared; village state and all graph memory preserved in FalkorDB`,
    data: { session },
  });
  return { session };
}

// ------------------------------------------------------------------ rounds

const farmerOpts = (o: RunOpts): RunOpts => o;

async function round1(sim: string, o: RunOpts) {
  const d = await decideProposal(sim, "farmer", "trader", { res: "food", qty: 4 }, { res: "wood", qty: 4 }, 2, { ...o, memoryEnabled: true }, "r1:farmer:propose", "Small trade to start rebuilding the wood stock");
  await sleep(o.pace);
  const dec = await decideOffer(sim, "trader", d, { ...o, memoryEnabled: true, llm: null }, "r1:trader:respond");
  const r = await applyOfferDecision(sim, "trader", d, dec, "r1:trader:respond");
  if (r.deal.state === "accepted") await executeDeal(sim, d.id, { pace: o.pace });
  await settle(sim, ["farmer", "trader"], "Completed D-1 with the Trader");
}

async function round2(sim: string, o: RunOpts) {
  const d = await decideProposal(sim, "farmer", "trader", { res: "food", qty: 12 }, { res: "wood", qty: 8 }, 3, { ...o, memoryEnabled: true }, "r2:farmer:propose", "Large wood order, payment up front");
  const dec = await decideOffer(sim, "trader", d, { ...o, memoryEnabled: true, llm: null }, "r2:trader:respond");
  const r = await applyOfferDecision(sim, "trader", d, dec, "r2:trader:respond");
  if (r.deal.state !== "accepted") throw new ValidationError(`Scenario expected the Trader to accept ${d.id}, got ${r.deal.state}`);
  // The Farmer pays up front (unsecured). The Trader's wood is due in round 3.
  await sleep(o.pace);
  await setAgentStatus(sim, "farmer", "acting");
  await tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: d.id, from: "farmer", qty: 12, idemKey: `exec:${d.id}:P` } });
  await settle(sim, ["farmer"], `Paid 12 food for ${d.id}; waiting for 8 wood (due round 3)`);
  await settle(sim, ["trader"], `Accepted ${d.id}; owes 8 wood`);
}

async function round3(sim: string, o: RunOpts) {
  await sleep(o.pace);
  await setAgentStatus(sim, "trader", "acting");
  const deal = await getDeal(sim, "D-2");
  await recordEvent(sim, {
    key: "r3:scripted-default", type: "DEAL_BROKEN", actor: "system", outcome: "scripted",
    summary: "SCRIPTED EVENT: the Trader does not deliver the 8 wood owed under D-2",
    data: { scripted: true, dealId: deal.id },
  });
  await recordOutcomeAndMemory(sim, { dealId: "D-2", result: "broken", defaulter: "trader", reason: "scripted scenario event: Trader fails to deliver" });
  await settle(sim, ["trader"], "Failed to deliver D-2 (scripted)");
  await settle(sim, ["farmer"], "Lost 12 food on D-2; memory + beliefs updated");
  await settle(sim, ["mayor"], "Observed the broken deal D-2");
}

async function round4(sim: string, o: RunOpts) {
  const on = { ...o, memoryEnabled: true };
  // 1. Farmer notices the shortage and escalates.
  await setAgentStatus(sim, "farmer", "thinking");
  await sleep(o.pace);
  const w0 = await getWorldState(sim);
  const { view: fv } = await retrieve(sim, "farmer", "trader", on, "r4:farmer:retrieve");
  const gapF = w0.needs.farmerFoodGap, gapW = w0.needs.villageWoodGap;
  await recordDecision(sim, {
    key: "r4:farmer:escalate", agent: "farmer", action: "request_mayor_help", source: "policy", memoryEnabled: true,
    rationale: `Food is ${gapF} short of my reserve and village wood ${gapW} short. ${fv.episodic[0] ? `I remember ${fv.episodic[0].title}, so I will not ask the Trader directly` : "Escalating"}; asking the Mayor to coordinate.`,
    used: [...fv.episodic.slice(0, 1), ...fv.beliefs].map((m) => ({ uid: m.uid, role: "considered" as const })),
  });
  await recordEvent(sim, {
    key: "r4:shortage", type: "SHORTAGE_RAISED", actor: "farmer", outcome: "confirmed",
    summary: `Farmer raises a shortage: food ${w0.agents[0].resources.food}/${w0.sim.farmerFoodNeed} (short ${gapF}), village wood ${w0.needs.villageWood}/${w0.sim.villageWoodNeed} (short ${gapW})`,
    data: { foodGap: gapF, woodGap: gapW },
  });
  const { task: t1 } = await tools.request_agent_handoff({ sim, actor: "farmer", from: "farmer", to: "mayor", kind: "resolve_shortage", payload: { foodGap: gapF, woodGap: gapW }, idemKey: "r4:t1" });
  await settle(sim, ["farmer"], `Raised shortage and handed ${t1.id} to the Mayor`);

  // 2. Mayor reads the shared graph state, allocates what it can, asks the Trader for a proposal.
  await setAgentStatus(sim, "mayor", "thinking");
  await sleep(o.pace);
  const w1 = await tools.get_world_state({ sim });
  const { view: mv } = await retrieve(sim, "mayor", "trader", on, "r4:mayor:retrieve");
  const mayorFood = w1.agents.find((a) => a.id === "mayor")!.resources.food;
  const allocate = Math.min(w1.needs.farmerFoodGap, mayorFood);
  if (allocate > 0) {
    await tools.execute_validated_action({ sim, actor: "mayor", action: { kind: "ALLOCATE", from: "mayor", to: "farmer", resource: "food", qty: allocate, idemKey: "r4:alloc-food", taskId: t1.id } });
  }
  const woodGap = w1.needs.villageWoodGap;
  await recordDecision(sim, {
    key: "r4:mayor:plan", agent: "mayor", action: "coordinate_recovery", source: "policy", memoryEnabled: true,
    rationale: `Read world state: Farmer food short ${w1.needs.farmerFoodGap}, village wood short ${woodGap}. Allocate ${allocate} food from the store; ask the Trader for a revised wood proposal${mv.beliefs[0] ? ` (Trader reliability ${mv.beliefs[0].value?.toFixed(2)} — I will require staged delivery)` : ""}.`,
    used: [...mv.episodic.slice(0, 1), ...mv.beliefs, ...mv.procedures].map((m) => ({ uid: m.uid, role: "considered" as const })),
  });
  const { task: t2 } = await tools.request_agent_handoff({ sim, actor: "mayor", from: "mayor", to: "trader", kind: "request_proposal", payload: { need: { wood: woodGap }, offerTools: Math.ceil(woodGap / 2) }, dependsOn: t1.id, idemKey: "r4:t2" });
  await settle(sim, ["mayor"], `Allocated ${allocate} food to the Farmer; asked the Trader for ${woodGap} wood (${t2.id})`);

  // 3. Trader consults its own memory and makes a revised proposal.
  await setAgentStatus(sim, "trader", "thinking");
  await sleep(o.pace);
  const { view: tv } = await retrieve(sim, "trader", "*", on, "r4:trader:retrieve");
  const own = traderOffer(tv);
  const tools_ = Math.ceil(woodGap / 2);
  const proposal = await tools.propose_deal({
    sim, actor: "trader", idemKey: "r4:trader:propose",
    terms: { proposer: "trader", counterparty: "mayor", giveRes: "wood", giveQty: woodGap, getRes: "tools", getQty: tools_, deadlineRound: 4,
      leader: own.stagedLeaderTrader ? "trader" : null, note: `Revised proposal for ${t2.id}` },
  });
  const tdec = await recordDecision(sim, {
    key: "r4:trader:revise", agent: "trader", action: own.stagedLeaderTrader ? "propose_staged" : "propose_unsecured", source: "policy",
    memoryEnabled: true, rationale: own.rationale, respondsTo: undefined, used: own.used.map((m) => ({ uid: m.uid, role: "applied" as const })),
  });
  void tdec;
  await completeTask(sim, "trader", t2.id, `proposed ${proposal.deal.id}`);
  await settle(sim, ["trader"], `Proposed ${proposal.deal.id}: ${woodGap} wood for ${tools_} tools, delivering first`);

  // 4. Mayor evaluates (memory-aware) and executes.
  const dec = await decideOffer(sim, "mayor", proposal.deal, on, "r4:mayor:respond");
  const r = await applyOfferDecision(sim, "mayor", proposal.deal, dec, "r4:mayor:respond");
  if (r.deal.state === "accepted") await executeDeal(sim, proposal.deal.id, { pace: o.pace });
  await completeTask(sim, "mayor", t1.id, "shortage resolved");

  const w2 = await getWorldState(sim);
  const ok = w2.needs.farmerFoodGap === 0 && w2.needs.villageWoodGap === 0;
  await recordEvent(sim, {
    key: "r4:plan-complete", type: "PLAN_COMPLETED", actor: "mayor", outcome: ok ? "goal_met" : "goal_missed",
    summary: ok ? `Recovery plan completed: Farmer food ${w2.agents[0].resources.food}/${w2.sim.farmerFoodNeed}, village wood ${w2.needs.villageWood}/${w2.sim.villageWoodNeed}`
      : `Recovery plan finished but goals NOT met (food gap ${w2.needs.farmerFoodGap}, wood gap ${w2.needs.villageWoodGap})`,
    data: { foodGap: w2.needs.farmerFoodGap, woodGap: w2.needs.villageWoodGap },
  });
  await settle(sim, ["mayor"], ok ? "Recovery plan completed" : "Recovery incomplete");
}

async function round5(sim: string, o: RunOpts, sc: ScenarioConfig) {
  // New season pressure + a scripted market offer from the Trader (unsecured: Farmer pays first).
  await q(`MATCH (s:Simulation {uid:$su}) SET s.villageWoodNeed = $need`, { su: simUid(sim), need: sc.woodNeed });
  await recordEvent(sim, {
    key: "r5:season", type: "SEASON_STARTED", actor: "system", outcome: "confirmed",
    summary: `A harder winter: village now needs ${sc.woodNeed} wood. Scenario "${sc.title}" begins`, data: { scenario: sc.id, woodNeed: sc.woodNeed },
  });
  const offer = await tools.propose_deal({
    sim, actor: "trader", idemKey: "r5:trader:offer",
    terms: { proposer: "trader", counterparty: "farmer", giveRes: sc.get.res, giveQty: sc.get.qty, getRes: sc.give.res, getQty: sc.give.qty,
      deadlineRound: 5, leader: null, note: "Scripted market offer: payment up front" },
  });
  const dec = await decideOffer(sim, "farmer", offer.deal, o, "r5:farmer:respond");
  const r = await applyOfferDecision(sim, "farmer", offer.deal, dec, "r5:farmer:respond");
  let live = r.counter ?? r.deal;
  if (r.counter) {
    // The Trader answers the Farmer's counter-offer with the same deterministic rule as always.
    const tdec = await decideOffer(sim, "trader", r.counter, { ...o, memoryEnabled: true, llm: null }, "r5:trader:respond");
    const tr = await applyOfferDecision(sim, "trader", r.counter, tdec, "r5:trader:respond");
    live = tr.deal;
  }
  if (live.state === "accepted") {
    const farmerPrepays = live.leader !== "trader";
    const exposure = dealValue(sc.give.res, sc.give.qty);
    const defaulter = traderDefaults(exposure, !farmerPrepays) ? "trader" : undefined;
    if (defaulter) {
      // Unsecured deal: Farmer pays, Trader scripted to default; deadline is this round.
      await sleep(o.pace);
      await tools.execute_validated_action({ sim, actor: "farmer", action: { kind: "TRANSFER", dealId: live.id, from: "farmer", qty: live.counterparty === "farmer" ? live.getQty : live.giveQty, idemKey: `exec:${live.id}:P` } });
      await recordEvent(sim, {
        key: "r5:scripted-default", type: "DEAL_BROKEN", actor: "system", outcome: "scripted",
        summary: `SCRIPTED EVENT: the Trader again fails to deliver on ${live.id} (unsecured, prepaid)`, data: { scripted: true, dealId: live.id },
      });
      await recordOutcomeAndMemory(sim, { dealId: live.id, result: "broken", defaulter: "trader", reason: "scripted scenario event" });
    } else {
      await executeDeal(sim, live.id, { pace: o.pace });
    }
  }
  const w = await getWorldState(sim);
  const ok = w.needs.farmerFoodGap === 0 && w.needs.villageWoodGap === 0;
  await recordEvent(sim, {
    key: "r5:result", type: "PLAN_COMPLETED", actor: "mayor", outcome: ok ? "goal_met" : "goal_missed",
    summary: ok ? `Season goals met: village wood ${w.needs.villageWood}/${w.sim.villageWoodNeed}`
      : `Season goals NOT met: village wood ${w.needs.villageWood}/${w.sim.villageWoodNeed} (short ${w.needs.villageWoodGap})`,
    data: { woodGap: w.needs.villageWoodGap, memoryEnabled: o.memoryEnabled },
  });
  await settle(sim, ["farmer"], dec.option.id === "accept" ? "Accepted the offer as proposed" : `Chose: ${dec.option.id.replace("_", " ")}`);
  await settle(sim, ["trader", "mayor"], ok ? "Season goals met" : "Season goals not met");
}

/** Put agents back to idle with a human-readable last action. */
async function settle(sim: string, agents: AgentId[], last: string) {
  for (const a of agents) await setAgentStatus(sim, a, "idle", last);
}

// ------------------------------------------------------------------ driver

const running = new Set<string>();

export interface RoundResult { round: number; title: string }

export async function runNextRound(
  sim: string, opts: RunOpts, scenario: ScenarioConfig = DEFAULT_SCENARIO,
): Promise<RoundResult> {
  await requireSim(sim);
  if (running.has(sim)) throw new ValidationError("A round is already running for this simulation");
  running.add(sim);
  try {
    const s = (await ro(`MATCH (s:Simulation {uid:$u}) RETURN s.round AS round, s.session AS session, s.maxRound AS max`, { u: simUid(sim) }))[0];
    if (!s) throw new NotFoundError(`Simulation ${sim}`);
    const next = s.round + 1;
    if (next > s.max) throw new ValidationError("Scenario complete — reset the demo to run it again");
    if (next === 5 && s.session < 2) throw new ValidationError("Begin a new session first: round 5 must not rely on the previous session's context");
    const bumped = await q(`MATCH (s:Simulation {uid:$u}) WHERE s.round = $prev SET s.round = $next RETURN s.round AS r`, { u: simUid(sim), prev: s.round, next });
    if (!bumped.length) throw new ValidationError("Round counter changed concurrently; refresh and retry");
    try {
      const o = farmerOpts(opts);
      if (next === 1) await round1(sim, o);
      else if (next === 2) await round2(sim, o);
      else if (next === 3) await round3(sim, o);
      else if (next === 4) await round4(sim, o);
      else await round5(sim, o, scenario);
    } catch (e) {
      // Roll the counter back; every step is idempotent so "Run next round" can simply be retried.
      await q(`MATCH (s:Simulation {uid:$u}) WHERE s.round = $next SET s.round = $prev`, { u: simUid(sim), prev: s.round, next });
      await Promise.all((["farmer", "trader", "mayor"] as AgentId[]).map((a) => setAgentStatus(sim, a, "idle")));
      throw e;
    }
    return { round: next, title: ROUND_TITLES[next] };
  } finally {
    running.delete(sim);
  }
}

export { uid };
