import { q, uid, ensureSchema } from "@/lib/falkor";
import { AGENT_IDS, RESOURCES, AgentId, ResourceType } from "@/lib/domain";
import { recordEvent } from "./events";
import { recordOutcomeAndMemory } from "./memory";
import { simUid } from "./world";

export const INITIAL: Record<AgentId, Record<ResourceType, number>> = {
  farmer: { food: 40, wood: 2, tools: 8 },
  trader: { food: 6, wood: 30, tools: 6 },
  mayor: { food: 14, wood: 6, tools: 4 },
};

export const AGENT_META: Record<AgentId, { name: string; role: string; goal: string }> = {
  farmer: {
    name: "Farmer", role: "Food producer",
    goal: "Keep at least 30 food for the coming season and secure wood without taking unsecured risks.",
  },
  trader: {
    name: "Trader", role: "Merchant",
    goal: "Maximise profitable trades while keeping enough stock; accept, reject or counter offers.",
  },
  mayor: {
    name: "Mayor", role: "Coordinator",
    goal: "Prevent shortages: keep village wood at 18+, request proposals and coordinate handoffs.",
  },
};

export const SEASON = { farmerFoodNeed: 30, villageWoodNeed: 18, maxRound: 5 };

/** Wipe one simulation's nodes (other simulations in the same graph are untouched). */
export async function wipeSimulation(sim: string) {
  await ensureSchema();
  await q(`MATCH (n {sim:$sim}) DETACH DELETE n`, { sim });
}

/**
 * Create (or recreate) a simulation: village, agents, balances, predefined procedure and
 * one historical fulfilled deal (D-0) whose memories are written by the normal pipeline.
 */
export async function seedSimulation(sim: string, name = "Hollowbrook Village"): Promise<void> {
  await wipeSimulation(sim);
  await q(
    `CREATE (s:Simulation {uid:$su, sim:$sim, id:$sim, name:$name, round:0, session:1, seq:0, dealSeq:0, taskSeq:0,
        farmerFoodNeed:$ffn, villageWoodNeed:$vwn, maxRound:$maxRound, createdAt:$ts})
     CREATE (se:Session {uid:$seu, sim:$sim, n:1, startedAt:$ts, label:'Session 1'})
     CREATE (s)-[:HAS_SESSION]->(se)`,
    { su: simUid(sim), seu: uid(sim, "session|1"), sim, name, ffn: SEASON.farmerFoodNeed, vwn: SEASON.villageWoodNeed,
      maxRound: SEASON.maxRound, ts: new Date().toISOString() },
  );
  for (const a of AGENT_IDS) {
    const m = AGENT_META[a];
    await q(
      `MATCH (s:Simulation {uid:$su})
       CREATE (ag:Agent {uid:$au, sim:$sim, id:$id, name:$name, role:$role, goal:$goal, status:'idle',
         lastAction:'Waiting for the season to begin', lastActionRound:0})
       CREATE (s)-[:HAS_AGENT]->(ag)
       WITH ag
       UNWIND $res AS r
       CREATE (rn:Resource {uid:$sim + '|res|' + $id + '|' + r.t, sim:$sim, owner:$id, type:r.t, qty:r.q, initialQty:r.q})
       CREATE (ag)-[:OWNS]->(rn)`,
      { su: simUid(sim), au: uid(sim, `agent|${a}`), sim, id: a, name: m.name, role: m.role, goal: m.goal,
        res: RESOURCES.map((t) => ({ t, q: INITIAL[a][t] })) },
    );
  }
  // Predefined procedure known to the Farmer and the Mayor (everyone starts with this common sense).
  for (const a of ["farmer", "mayor"] as const) {
    await q(
      `MATCH (ag:Agent {uid:$au}), (s:Simulation {uid:$su})
       CREATE (p:Procedure {uid:$pu, sim:$sim, id:$pid, owner:$a, partner:'*', epistemic:'suggested', status:'predefined',
         title:'Secure risky exchanges',
         content:'If the partner\\'s estimated reliability is below 0.6 and the exchange is worth ≥ 6, do not prepay: require staged delivery with the partner delivering first.',
         params:$params, successCount:0, failureCount:0, round:0, ts:$ts})
       CREATE (ag)-[:KNOWS]->(p)`,
      { au: uid(sim, `agent|${a}`), su: simUid(sim), pu: uid(sim, `proc|secure-risky|${a}`), sim, pid: `P-secure-risky-${a}`, a,
        params: JSON.stringify({ partner: "*", minValue: 6, reliabilityThreshold: 0.6, mode: "staged_delivery" }), ts: new Date().toISOString() },
    );
  }
  await recordEvent(sim, {
    key: "seed", type: "SIM_SEEDED", actor: "system", outcome: "confirmed",
    summary: "Village created: Farmer, Trader and Mayor start the season with their stores",
  });

  // Pre-history: D-0 was fulfilled before round 0 (balances above already reflect it).
  await q(
    `MATCH (s:Simulation {uid:$su})
     SET s.dealSeq = 0
     CREATE (d:Deal {uid:$du, id:'D-0', n:0, sim:$sim, state:'fulfilled', proposer:'farmer', counterparty:'trader',
       giveRes:'food', giveQty:5, getRes:'wood', getQty:3, proposerDelivered:5, counterpartyDelivered:3,
       deadlineRound:0, leader:'', createdRound:0, parentDealId:'', note:'Historic trade before the season', defaulter:''})
     CREATE (s)-[:HAS_DEAL]->(d)
     WITH d
     MATCH (f:Agent {uid:$fu}), (t:Agent {uid:$tu})
     CREATE (f)-[:PROPOSED]->(d), (d)-[:WITH]->(t), (t)-[:ACCEPTED]->(d)`,
    { su: simUid(sim), du: uid(sim, "deal|D-0"), sim, fu: uid(sim, "agent|farmer"), tu: uid(sim, "agent|trader") },
  );
  await recordOutcomeAndMemory(sim, { dealId: "D-0", result: "fulfilled" });
}
