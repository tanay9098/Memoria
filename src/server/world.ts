import { q, ro, uid, Row } from "@/lib/falkor";
import { AGENT_IDS, AgentId, DealState, RESOURCES, ResourceType } from "@/lib/domain";
import { P } from "./events";

export class NotFoundError extends Error {
  constructor(what: string) { super(`${what} not found`); this.name = "NotFoundError"; }
}
export class ValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = "ValidationError"; }
}

export interface DealView {
  id: string; uid: string; state: DealState; proposer: AgentId; counterparty: AgentId;
  giveRes: ResourceType; giveQty: number; getRes: ResourceType; getQty: number;
  proposerDelivered: number; counterpartyDelivered: number; deadlineRound: number;
  leader: AgentId | null; secured: boolean; createdRound: number; parentDealId: string | null; note: string;
  defaulter: string | null;
}
export interface AgentView {
  id: AgentId; name: string; role: string; goal: string; status: string; lastAction: string;
  lastActionRound: number; resources: Record<ResourceType, number>;
}
export interface TaskView {
  id: string; kind: string; state: string; from: string; to: string; round: number; dependsOn: string | null;
  payload: Record<string, unknown>;
}
export interface EventView {
  uid: string; seq: number; type: string; category: string; actor: string; outcome: string; summary: string;
  round: number; session: number; ts: string; data: Record<string, unknown>;
}
export interface WorldState {
  sim: { id: string; name: string; round: number; session: number; farmerFoodNeed: number; villageWoodNeed: number; maxRound: number };
  agents: AgentView[];
  totals: Record<ResourceType, number>;
  needs: { farmerFoodGap: number; villageWood: number; villageWoodGap: number };
  deals: DealView[];
  openDeals: number;
  tasks: TaskView[];
}

export const simUid = (sim: string) => uid(sim, "sim");
export const agentUid = (sim: string, a: string) => uid(sim, `agent|${a}`);
export const dealUid = (sim: string, d: string) => uid(sim, `deal|${d}`);
export const resUid = (sim: string, a: string, r: string) => uid(sim, `res|${a}|${r}`);

export function dealView(d: Row): DealView {
  return {
    id: d.id, uid: d.uid, state: d.state as DealState, proposer: d.proposer, counterparty: d.counterparty,
    giveRes: d.giveRes, giveQty: d.giveQty, getRes: d.getRes, getQty: d.getQty,
    proposerDelivered: d.proposerDelivered, counterpartyDelivered: d.counterpartyDelivered,
    deadlineRound: d.deadlineRound, leader: d.leader || null, secured: !!d.leader,
    createdRound: d.createdRound, parentDealId: d.parentDealId || null, note: d.note ?? "",
    defaulter: d.defaulter || null,
  };
}

export async function simExists(sim: string): Promise<boolean> {
  const r = await ro(`MATCH (s:Simulation {uid:$u}) RETURN s.id AS id`, { u: simUid(sim) });
  return r.length > 0;
}

export async function requireSim(sim: string) {
  if (!(await simExists(sim))) throw new NotFoundError(`Simulation '${sim}' (run the seed / reset first)`);
}

export async function getWorldState(sim: string): Promise<WorldState> {
  const [s] = await ro(`MATCH (s:Simulation {uid:$u}) RETURN s`, { u: simUid(sim) });
  if (!s) throw new NotFoundError(`Simulation '${sim}'`);
  const sp = P(s.s);
  const agentRows = await ro(
    `MATCH (a:Agent {sim:$sim}) OPTIONAL MATCH (a)-[:OWNS]->(r:Resource)
     RETURN a, collect({t:r.type, q:r.qty}) AS res`,
    { sim },
  );
  const agents: AgentView[] = agentRows.map((row) => {
    const a = P(row.a);
    const resources = { food: 0, wood: 0, tools: 0 } as Record<ResourceType, number>;
    for (const r of row.res) if (r.t) resources[r.t as ResourceType] = r.q;
    return {
      id: a.id, name: a.name, role: a.role, goal: a.goal, status: a.status, lastAction: a.lastAction,
      lastActionRound: a.lastActionRound, resources,
    };
  }).sort((x, y) => AGENT_IDS.indexOf(x.id) - AGENT_IDS.indexOf(y.id));
  const totals = { food: 0, wood: 0, tools: 0 } as Record<ResourceType, number>;
  for (const a of agents) for (const r of RESOURCES) totals[r] += a.resources[r];

  const dealRows = await ro(`MATCH (d:Deal {sim:$sim}) RETURN d ORDER BY d.n`, { sim });
  const deals = dealRows.map((r) => dealView(P(r.d)));
  const taskRows = await ro(`MATCH (t:Task {sim:$sim}) RETURN t ORDER BY t.n`, { sim });
  const tasks: TaskView[] = taskRows.map((r) => {
    const t = P(r.t);
    return { id: t.id, kind: t.kind, state: t.state, from: t.from, to: t.to, round: t.round,
      dependsOn: t.dependsOn || null, payload: JSON.parse(t.payload || "{}") };
  });

  const byId = Object.fromEntries(agents.map((a) => [a.id, a])) as Record<AgentId, AgentView>;
  const villageWood = (byId.farmer?.resources.wood ?? 0) + (byId.mayor?.resources.wood ?? 0);
  return {
    sim: { id: sim, name: sp.name, round: sp.round, session: sp.session, farmerFoodNeed: sp.farmerFoodNeed,
      villageWoodNeed: sp.villageWoodNeed, maxRound: sp.maxRound },
    agents, totals,
    needs: {
      farmerFoodGap: Math.max(0, sp.farmerFoodNeed - (byId.farmer?.resources.food ?? 0)),
      villageWood,
      villageWoodGap: Math.max(0, sp.villageWoodNeed - villageWood),
    },
    deals,
    openDeals: deals.filter((d) => d.state === "proposed" || d.state === "accepted").length,
    tasks,
  };
}

export async function getDeal(sim: string, dealId: string): Promise<DealView> {
  const r = await ro(`MATCH (d:Deal {uid:$u}) RETURN d`, { u: dealUid(sim, dealId) });
  if (!r.length) throw new NotFoundError(`Deal ${dealId}`);
  return dealView(P(r[0].d));
}

export async function getEvents(sim: string, opts: { limit?: number; sinceSeq?: number } = {}): Promise<EventView[]> {
  const rows = await ro(
    `MATCH (e:Event {sim:$sim}) WHERE e.seq > $since RETURN e ORDER BY e.seq DESC LIMIT $limit`,
    { sim, since: opts.sinceSeq ?? -1, limit: opts.limit ?? 60 },
  );
  return rows.map((r) => eventView(P(r.e)));
}

export function eventView(e: Row): EventView {
  return {
    uid: e.uid, seq: e.seq, type: e.type, category: e.category, actor: e.actor, outcome: e.outcome,
    summary: e.summary, round: e.round, session: e.session, ts: e.ts, data: JSON.parse(e.data || "{}"),
  };
}

export async function setAgentStatus(sim: string, agent: AgentId, status: string, lastAction?: string) {
  await q(
    `MATCH (a:Agent {uid:$u}), (s:Simulation {uid:$su})
     SET a.status = $status
     SET a.lastAction = CASE WHEN $last IS NULL THEN a.lastAction ELSE $last END,
         a.lastActionRound = CASE WHEN $last IS NULL THEN a.lastActionRound ELSE s.round END`,
    { u: agentUid(sim, agent), su: simUid(sim), status, last: lastAction ?? null },
  );
}
