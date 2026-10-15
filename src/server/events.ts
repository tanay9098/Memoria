import { q, uid, Row } from "@/lib/falkor";
import { EVENT_CATEGORY, EventType } from "@/lib/domain";

/** FalkorDB returns nodes as {id, labels, properties}; flatten to the property bag. */
export const P = (x: any): Row => (x && typeof x === "object" && "properties" in x ? x.properties : x);

export interface EventSpec {
  /** Idempotency key: the same key can create the event at most once. */
  key: string;
  type: EventType;
  actor: string; // agent id or "system"
  outcome: string;
  summary: string;
  data?: Record<string, unknown>;
}

export function evParams(sim: string, spec: EventSpec) {
  return {
    sim,
    simUid: uid(sim, "sim"),
    evUid: uid(sim, `ev|${spec.key}`),
    evType: spec.type,
    evCat: EVENT_CATEGORY[spec.type],
    evActor: spec.actor,
    evOutcome: spec.outcome,
    evSummary: spec.summary,
    evData: JSON.stringify(spec.data ?? {}),
    evTs: new Date().toISOString(),
  };
}

/**
 * Cypher fragment that appends an Event node to a query that has `sim` in scope.
 * Embedding it in the same statement as the state change makes "state changed" and
 * "event recorded" a single atomic FalkorDB write.
 */
export const EVENT_CLAUSE = `
SET sim.seq = sim.seq + 1
CREATE (ev:Event {uid:$evUid, sim:$sim, type:$evType, category:$evCat, actor:$evActor, outcome:$evOutcome,
  summary:$evSummary, data:$evData, round:sim.round, session:sim.session, seq:sim.seq, ts:$evTs})
CREATE (sim)-[:HAS_EVENT]->(ev)`;

/** Standalone, idempotent event creation (no accompanying state change). */
export async function recordEvent(
  sim: string,
  spec: EventSpec,
  affects: string[] = [],
): Promise<{ created: boolean; uid: string }> {
  const p = evParams(sim, spec);
  const rows = await q<{ seq: number }>(
    `MATCH (sim:Simulation {uid:$simUid})
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, old WHERE old IS NULL
     ${EVENT_CLAUSE}
     WITH ev
     OPTIONAL MATCH (a:Agent {uid:$actorUid})
     FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (a)-[:PERFORMED]->(ev))
     RETURN ev.seq AS seq`,
    { ...p, actorUid: uid(sim, `agent|${spec.actor}`) },
  );
  const created = rows.length > 0;
  if (created && affects.length) await linkAffected(sim, p.evUid, affects);
  return { created, uid: p.evUid };
}

export async function linkAffected(sim: string, evUid: string, targetUids: string[]) {
  if (!targetUids.length) return;
  await q(
    `MATCH (ev:Event {uid:$evUid})
     UNWIND $targets AS t
     MATCH (x {uid:t, sim:$sim})
     MERGE (ev)-[:AFFECTED]->(x)`,
    { evUid, targets: targetUids, sim },
  );
}
