import { q, ro, uid, Row } from "@/lib/falkor";
import { AGENT_IDS, AgentId, outcomeSchema } from "@/lib/domain";
import { EventSpec, P, evParams, EVENT_CLAUSE, recordEvent, linkAffected } from "./events";
import { markDealBroken, nm, describeTerms } from "./deals";
import { DealView, NotFoundError, ValidationError, agentUid, dealUid, getDeal, requireSim, simUid } from "./world";

export const RELIABILITY_THRESHOLD = 0.6;
export const BREACH_WEIGHT = 3;

/** Documented belief rule: broken delivery counts as BREACH_WEIGHT fulfilled deals. */
export function reliability(fulfilled: number, broken: number): number {
  return Math.round(((1 + fulfilled) / (2 + fulfilled + BREACH_WEIGHT * broken)) * 100) / 100;
}

export interface MemoryItem {
  uid: string;
  id: string;
  kind: "episodic" | "semantic" | "procedural";
  epistemic: "observed" | "inferred" | "suggested";
  title: string;
  content: string;
  status: string;
  confidence: number | null;
  value: number | null;
  round: number;
  ts: string;
  owner: string;
  subjects: string[];
  dealId: string | null;
  eventUid: string | null;
  evidence: { uid: string; summary: string; eventUid: string | null }[];
  revisions: { from: number; to: number; round: number; reason: string }[];
  influenced: { decisionUid: string; agent: string; round: number; action: string; sessionNo: number }[];
  params: Record<string, any> | null;
  stats: { successCount: number; failureCount: number } | null;
}

// ------------------------------------------------------------------ retrieval

const influencedOf = (rows: Row[]) =>
  rows.filter((d) => d && d.uid).map((d) => ({ decisionUid: d.uid, agent: d.agent, round: d.round, action: d.action, sessionNo: d.session }));

export async function getAgentMemories(
  sim: string,
  agent: AgentId,
  opts: { about?: string; kinds?: MemoryItem["kind"][]; limit?: number } = {},
): Promise<MemoryItem[]> {
  const kinds = opts.kinds ?? ["episodic", "semantic", "procedural"];
  const items: MemoryItem[] = [];
  const aUid = agentUid(sim, agent);

  if (kinds.includes("episodic")) {
    const rows = await ro(
      `MATCH (a:Agent {uid:$a})-[:REMEMBERS]->(m:Memory)
       OPTIONAL MATCH (m)-[:ABOUT]->(s:Agent)
       OPTIONAL MATCH (m)-[:ABOUT]->(d:Deal)
       OPTIONAL MATCH (m)-[:LEARNED_FROM]->(e:Event)
       OPTIONAL MATCH (ev:Evidence)-[:SUPPORTS]->(m)
       OPTIONAL MATCH (ev)-[:OBSERVED_IN]->(ee:Event)
       OPTIONAL MATCH (dec:Decision)-[:USED]->(m)
       RETURN m, collect(DISTINCT s.id) AS subjects, d.id AS dealId, e.uid AS eventUid,
              collect(DISTINCT {uid:ev.uid, summary:ev.summary, eventUid:ee.uid}) AS evidence,
              collect(DISTINCT {uid:dec.uid, agent:dec.agent, round:dec.round, action:dec.action, session:dec.session}) AS used`,
      { a: aUid },
    );
    for (const r of rows) {
      const m = P(r.m);
      items.push({
        uid: m.uid, id: m.id, kind: "episodic", epistemic: "observed", title: m.title, content: m.content,
        status: m.status, confidence: m.confidence ?? 1, value: null, round: m.round, ts: m.ts, owner: agent,
        subjects: r.subjects, dealId: r.dealId ?? null, eventUid: r.eventUid ?? null,
        evidence: r.evidence.filter((e: Row) => e.uid), revisions: [], influenced: influencedOf(r.used),
        params: null, stats: null,
      });
    }
  }
  if (kinds.includes("semantic")) {
    const rows = await ro(
      `MATCH (a:Agent {uid:$a})-[:BELIEVES]->(k:Knowledge)-[:ABOUT]->(s:Agent)
       OPTIONAL MATCH (ev:Evidence)-[:SUPPORTS]->(k)
       OPTIONAL MATCH (ev)-[:OBSERVED_IN]->(ee:Event)
       OPTIONAL MATCH (k)-[:HAS_REVISION]->(r:Revision)
       OPTIONAL MATCH (dec:Decision)-[:USED]->(k)
       RETURN k, s.id AS subject,
              collect(DISTINCT {uid:ev.uid, summary:ev.summary, eventUid:ee.uid}) AS evidence,
              collect(DISTINCT {from:r.from, to:r.to, round:r.round, reason:r.reason, ts:r.ts}) AS revs,
              collect(DISTINCT {uid:dec.uid, agent:dec.agent, round:dec.round, action:dec.action, session:dec.session}) AS used`,
      { a: aUid },
    );
    for (const r of rows) {
      const k = P(r.k);
      items.push({
        uid: k.uid, id: k.id, kind: "semantic", epistemic: "inferred", title: k.title, content: k.content,
        status: k.status, confidence: k.confidence, value: k.value, round: k.updatedRound, ts: k.ts, owner: agent,
        subjects: [r.subject], dealId: null, eventUid: null,
        evidence: r.evidence.filter((e: Row) => e.uid),
        revisions: r.revs.filter((x: Row) => x.ts).sort((x: Row, y: Row) => (x.ts < y.ts ? -1 : 1)),
        influenced: influencedOf(r.used), params: null, stats: null,
      });
    }
  }
  if (kinds.includes("procedural")) {
    const rows = await ro(
      `MATCH (a:Agent {uid:$a})-[:KNOWS]->(p:Procedure)
       OPTIONAL MATCH (ev:Evidence)-[:SUPPORTS]->(p)
       OPTIONAL MATCH (ev)-[:OBSERVED_IN]->(ee:Event)
       OPTIONAL MATCH (p)-[:LEARNED_FROM]->(src:Event)
       OPTIONAL MATCH (dec:Decision)-[:USED]->(p)
       RETURN p, src.uid AS srcUid,
              collect(DISTINCT {uid:ev.uid, summary:ev.summary, eventUid:ee.uid}) AS evidence,
              collect(DISTINCT {uid:dec.uid, agent:dec.agent, round:dec.round, action:dec.action, session:dec.session}) AS used`,
      { a: aUid },
    );
    for (const r of rows) {
      const p = P(r.p);
      const params = JSON.parse(p.params || "{}");
      items.push({
        uid: p.uid, id: p.id, kind: "procedural", epistemic: "suggested", title: p.title, content: p.content,
        status: p.status, confidence: null, value: null, round: p.round, ts: p.ts, owner: agent,
        subjects: params.partner ? [params.partner] : [], dealId: null, eventUid: r.srcUid ?? null,
        evidence: r.evidence.filter((e: Row) => e.uid), revisions: [], influenced: influencedOf(r.used),
        params, stats: { successCount: p.successCount ?? 0, failureCount: p.failureCount ?? 0 },
      });
    }
  }
  let out = items;
  if (opts.about) out = out.filter((i) => i.subjects.includes(opts.about!) || i.subjects.length === 0);
  out.sort((x, y) => (y.round - x.round) || (x.kind < y.kind ? -1 : 1));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export async function getMemoryByUid(sim: string, memUid: string): Promise<MemoryItem> {
  const rows = await ro(`MATCH (a:Agent)-[r]->(n {uid:$u}) WHERE a.sim = $sim AND type(r) IN ['REMEMBERS','BELIEVES','KNOWS'] RETURN a.id AS owner`, { u: memUid, sim });
  if (!rows.length) throw new NotFoundError(`Memory ${memUid}`);
  const all = await getAgentMemories(sim, rows[0].owner);
  const hit = all.find((m) => m.uid === memUid);
  if (!hit) throw new NotFoundError(`Memory ${memUid}`);
  return hit;
}

export interface RelatedEvent { uid: string; seq: number; type: string; summary: string; round: number; actor: string }
export async function findRelatedEvents(
  sim: string, opts: { dealId?: string; agent?: string; limit?: number },
): Promise<RelatedEvent[]> {
  const limit = opts.limit ?? 20;
  const rows = opts.dealId
    ? await ro(`MATCH (e:Event {sim:$sim})-[:AFFECTED]->(d:Deal {uid:$u}) RETURN e ORDER BY e.seq LIMIT $limit`,
        { sim, u: dealUid(sim, opts.dealId), limit })
    : opts.agent
      ? await ro(`MATCH (e:Event {sim:$sim}) WHERE e.actor = $agent OR (e)-[:AFFECTED]->(:Agent {uid:$au})
                  RETURN e ORDER BY e.seq DESC LIMIT $limit`, { sim, agent: opts.agent, au: agentUid(sim, opts.agent), limit })
      : await ro(`MATCH (e:Event {sim:$sim}) RETURN e ORDER BY e.seq DESC LIMIT $limit`, { sim, limit });
  return rows.map((r) => {
    const e = P(r.e);
    return { uid: e.uid, seq: e.seq, type: e.type, summary: e.summary, round: e.round, actor: e.actor };
  });
}

// ------------------------------------------------------------------ writing: outcome → memories

const lines = (d: DealView) => `${d.id}: ${nm(d.proposer)} gave ${d.giveQty} ${d.giveRes}, ${nm(d.counterparty)} was to give ${d.getQty} ${d.getRes}`;

function episodicText(d: DealView, observer: string, result: "fulfilled" | "broken", defaulter?: string): { title: string; content: string } {
  const other = observer === d.proposer ? d.counterparty : observer === d.counterparty ? d.proposer : null;
  if (result === "fulfilled") {
    return {
      title: `Deal ${d.id} fulfilled`,
      content: other
        ? `Deal ${d.id} with ${nm(other)} completed: I ${observer === d.proposer ? `gave ${d.giveQty} ${d.giveRes} and received ${d.getQty} ${d.getRes}` : `gave ${d.getQty} ${d.getRes} and received ${d.giveQty} ${d.giveRes}`}. Both sides delivered${d.leader ? " in stages" : ""}.`
        : `Observed deal ${lines(d)}; both sides delivered.`,
    };
  }
  const owed = defaulter === d.proposer ? `${d.giveQty - d.proposerDelivered} ${d.giveRes}` : `${d.getQty - d.counterpartyDelivered} ${d.getRes}`;
  const paid = defaulter === d.proposer ? `${d.counterpartyDelivered} ${d.getRes}` : `${d.proposerDelivered} ${d.giveRes}`;
  const base = `${nm(defaulter!)} accepted deal ${d.id} (${describeTerms(d)}), but failed to deliver the outstanding ${owed} before the round-${d.deadlineRound} deadline; the counterparty had already delivered ${paid}.`;
  if (observer === defaulter) return { title: `I broke deal ${d.id}`, content: `I accepted deal ${d.id} and failed to deliver ${owed} before the deadline. ${nm(other!)} had delivered ${paid}.` };
  if (other) return { title: `Deal ${d.id} broken by ${nm(defaulter!)}`, content: `${base} I was the injured party.` };
  return { title: `Deal ${d.id} broken by ${nm(defaulter!)}`, content: `Observed: ${base}` };
}

export interface OutcomeResult {
  dealId: string; result: "fulfilled" | "broken"; replayed: boolean; memoriesWritten: number;
  trustChanges: { observer: string; subject: string; from: number; to: number }[]; lesson?: string; validatedProcedures: string[];
}

/**
 * record_outcome_and_memory — the one entry point that turns a finished deal into
 * graph memory. Every sub-step is idempotent (MERGE / keyed events), so a retry after
 * a partial failure completes the remaining steps without duplicating anything.
 */
export async function recordOutcomeAndMemory(sim: string, raw: unknown): Promise<OutcomeResult> {
  await requireSim(sim);
  const o = outcomeSchema.parse(raw);
  let deal = await getDeal(sim, o.dealId);
  let replayed = false;

  if (o.result === "fulfilled") {
    if (deal.state !== "fulfilled") throw new ValidationError(`${o.dealId} is ${deal.state}, not fulfilled — outcome cannot be recorded`);
    const e = await recordEvent(sim, {
      key: `outcome:${o.dealId}:fulfilled`, type: "DEAL_FULFILLED", actor: "system", outcome: "confirmed",
      summary: `${o.dealId} FULFILLED: ${describeTerms(deal)}`, data: { dealId: o.dealId },
    }, [dealUid(sim, o.dealId)]);
    replayed = !e.created;
  } else {
    if (!o.defaulter) throw new ValidationError("A broken outcome must name the defaulter");
    const r = await markDealBroken(sim, o.dealId, o.defaulter, o.reason ?? "deadline passed");
    deal = r.deal;
    replayed = r.replayed;
  }
  deal = await getDeal(sim, o.dealId);
  const defaulter = o.result === "broken" ? (deal.defaulter ?? o.defaulter!) : undefined;
  const evUid = uid(sim, `ev|outcome:${o.dealId}:${o.result}`);

  // Evidence is the objective, shareable record; everything else points back at it.
  const evidenceUid = uid(sim, `evidence|${o.dealId}|${o.result}`);
  const evSummary = o.result === "fulfilled"
    ? `Both parties delivered in full on ${lines(deal)}.`
    : `${nm(defaulter!)} delivered ${defaulter === deal.proposer ? deal.proposerDelivered : deal.counterpartyDelivered} of ${defaulter === deal.proposer ? deal.giveQty : deal.getQty} owed on ${lines(deal)}; deadline round ${deal.deadlineRound}.`;
  await q(
    `MATCH (sim:Simulation {uid:$simUid}), (e:Event {uid:$evUid}), (d:Deal {uid:$dealUid})
     MERGE (ev:Evidence {uid:$eUid})
       ON CREATE SET ev.sim=$sim, ev.id=$eId, ev.kind='deal_outcome', ev.epistemic='observed', ev.summary=$summary,
                     ev.round=sim.round, ev.ts=$ts
     MERGE (ev)-[:OBSERVED_IN]->(e)
     MERGE (ev)-[:ABOUT]->(d)`,
    { simUid: simUid(sim), evUid, dealUid: dealUid(sim, o.dealId), eUid: evidenceUid, eId: `EV-${o.dealId}-${o.result}`,
      sim, summary: evSummary, ts: new Date().toISOString() },
  );

  // Episodic memories: both parties + the Mayor (who oversees all village deals).
  const observers = Array.from(new Set<string>([deal.proposer, deal.counterparty, "mayor"]));
  let memoriesWritten = 0;
  for (const obs of observers) {
    const t = episodicText(deal, obs, o.result, defaulter);
    const mUid = uid(sim, `mem|${obs}|${o.dealId}|${o.result}`);
    const subjects = [deal.proposer, deal.counterparty].filter((x) => x !== obs);
    await q(
      `MATCH (sim:Simulation {uid:$simUid}), (a:Agent {uid:$aUid}), (e:Event {uid:$evUid}), (d:Deal {uid:$dealUid}),
             (evd:Evidence {uid:$eUid})
       MERGE (m:Memory {uid:$mUid})
         ON CREATE SET m.sim=$sim, m.id=$mId, m.type='episodic', m.epistemic='observed', m.title=$title, m.content=$content,
                       m.status='active', m.confidence=1.0, m.round=sim.round, m.ts=$ts, m.outcome=$result
       MERGE (a)-[:REMEMBERS]->(m)
       MERGE (m)-[:ABOUT]->(d)
       MERGE (m)-[:LEARNED_FROM]->(e)
       MERGE (evd)-[:SUPPORTS]->(m)
       WITH m
       UNWIND $subjects AS s
       MATCH (sa:Agent {uid:s})
       MERGE (m)-[:ABOUT]->(sa)`,
      { simUid: simUid(sim), aUid: agentUid(sim, obs), evUid, dealUid: dealUid(sim, o.dealId), eUid: evidenceUid,
        mUid, mId: `M-${obs}-${o.dealId}`, sim, title: t.title, content: t.content, ts: new Date().toISOString(),
        result: o.result, subjects: subjects.map((s) => agentUid(sim, s)) },
    );
    memoriesWritten++;
  }
  await recordEvent(sim, {
    key: `memwrite:${o.dealId}:${o.result}`, type: "MEMORY_WRITTEN", actor: "system", outcome: "confirmed",
    summary: `${memoriesWritten} episodic memories stored for ${o.dealId} (${o.result}); evidence EV-${o.dealId}-${o.result}`,
    data: { dealId: o.dealId, observers },
  }, [dealUid(sim, o.dealId)]);

  // Semantic memory: recompute each observer's belief about each other party from graph evidence.
  const trustChanges: OutcomeResult["trustChanges"] = [];
  for (const obs of observers) {
    for (const subj of [deal.proposer, deal.counterparty]) {
      if (subj === obs) continue;
      const ch = await updateBelief(sim, obs, subj, deal, evidenceUid);
      if (ch) trustChanges.push({ observer: obs, subject: subj, from: ch.from, to: ch.to });
    }
  }
  if (trustChanges.length) {
    await recordEvent(sim, {
      key: `trust:${o.dealId}:${o.result}`, type: "TRUST_UPDATED", actor: "system", outcome: "confirmed",
      summary: "Reliability beliefs updated — " + trustChanges.map((c) => `${nm(c.observer)}→${nm(c.subject)} ${c.from.toFixed(2)}→${c.to.toFixed(2)}`).join(", "),
      data: { dealId: o.dealId, changes: trustChanges },
    }, [dealUid(sim, o.dealId)]);
  }

  // Procedural memory.
  let lesson: string | undefined;
  const validatedProcedures: string[] = [];
  if (o.result === "broken") {
    const victim = defaulter === deal.proposer ? deal.counterparty : deal.proposer;
    lesson = await proposeLesson(sim, victim as AgentId, defaulter as AgentId, deal, evidenceUid, evUid);
  } else {
    validatedProcedures.push(...(await validateProcedures(sim, deal, evidenceUid, evUid)));
  }
  return { dealId: o.dealId, result: o.result, replayed, memoriesWritten, trustChanges, lesson, validatedProcedures };
}

async function updateBelief(
  sim: string, observer: string, subject: string, deal: DealView, evidenceUid: string,
): Promise<{ from: number; to: number } | null> {
  const revUid = uid(sim, `rev|${observer}|${subject}|${deal.id}`);
  if ((await ro(`MATCH (r:Revision {uid:$u}) RETURN r.uid AS u`, { u: revUid })).length) return null; // already applied
  const counts = await ro(
    `MATCH (d:Deal {sim:$sim}) WHERE d.state IN ['fulfilled','broken']
       AND ($o IN [d.proposer, d.counterparty] OR $o = 'mayor') AND $s IN [d.proposer, d.counterparty]
     RETURN d.state AS st, d.defaulter AS def, count(d) AS n`, { sim, o: observer, s: subject });
  let fulfilled = 0, broken = 0;
  for (const c of counts) {
    if (c.st === "fulfilled") fulfilled += c.n;
    else if (c.def === subject) broken += c.n; // a deal broken by someone else says nothing about `subject`
  }
  const value = reliability(fulfilled, broken);
  const n = fulfilled + broken;
  const confidence = Math.round((n / (n + 2)) * 100) / 100;
  const content = `${nm(observer)}'s estimate of ${nm(subject)}'s delivery reliability is ${value.toFixed(2)} ` +
    `(${fulfilled} fulfilled, ${broken} broken; broken deliveries weigh ${BREACH_WEIGHT}×). This is an inference from evidence, not a fact.`;
  const kUid = uid(sim, `belief|${observer}|${subject}|reliability`);
  const reason = `${deal.id} ${deal.state}`;
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid}), (obs:Agent {uid:$obsUid}), (subj:Agent {uid:$subjUid}), (ev:Evidence {uid:$eUid})
     MERGE (k:Knowledge {uid:$kUid})
       ON CREATE SET k.sim=$sim, k.id=$kId, k.owner=$observer, k.subject=$subject, k.topic='delivery_reliability',
                     k.epistemic='inferred', k.value=0.5, k.createdRound=sim.round
     MERGE (obs)-[:BELIEVES]->(k)
     MERGE (k)-[:ABOUT]->(subj)
     WITH sim, k, ev, k.value AS oldValue
     SET k.value=$value, k.fulfilled=$fulfilled, k.broken=$broken, k.content=$content, k.confidence=$confidence,
         k.title=$title, k.status=$status, k.updatedRound=sim.round, k.ts=$ts
     CREATE (r:Revision {uid:$revUid, sim:$sim, from:oldValue, to:$value, round:sim.round, reason:$reason, ts:$ts})
     CREATE (k)-[:HAS_REVISION]->(r), (ev)-[:SUPPORTS]->(k), (r)-[:BASED_ON]->(ev)
     RETURN oldValue AS oldValue`,
    {
      simUid: simUid(sim), obsUid: agentUid(sim, observer), subjUid: agentUid(sim, subject), eUid: evidenceUid, kUid,
      kId: `K-${observer}-${subject}-reliability`, sim, observer, subject, value, fulfilled, broken, content, confidence,
      title: `${nm(observer)} → ${nm(subject)}: delivery reliability`, status: n < 2 ? "tentative" : "established",
      ts: new Date().toISOString(), revUid, reason,
    },
  );
  const from = rows[0].oldValue as number;
  if (value < RELIABILITY_THRESHOLD) {
    await q(
      `MATCH (k:Knowledge {uid:$k}), (a:Agent {uid:$a})-[:KNOWS]->(p:Procedure) WHERE p.status IN ['predefined','proposed','supported']
         AND (p.partner = '*' OR p.partner = $subject)
       MERGE (k)-[:RECOMMENDS]->(p)`,
      { k: kUid, a: agentUid(sim, observer), subject },
    );
  }
  return { from, to: value };
}

async function proposeLesson(
  sim: string, victim: AgentId, defaulter: AgentId, deal: DealView, evidenceUid: string, evUid: string,
): Promise<string> {
  const pUid = uid(sim, `proc|lesson|${victim}|${defaulter}`);
  const params = { partner: defaulter, minValue: 4, reliabilityThreshold: RELIABILITY_THRESHOLD, mode: "staged_delivery" };
  const content = `With ${nm(defaulter)}, do not prepay on deals worth ≥ ${params.minValue}: counter with staged delivery so ${nm(defaulter)} delivers first. ` +
    `Suggested after ${deal.id} was broken. Unproven until a staged deal is fulfilled.`;
  const created = await q(
    `MATCH (sim:Simulation {uid:$simUid}), (a:Agent {uid:$aUid}), (e:Event {uid:$evUid}), (ev:Evidence {uid:$eUid})
     OPTIONAL MATCH (old:Procedure {uid:$pUid})
     WITH sim, a, e, ev, old WHERE old IS NULL
     CREATE (p:Procedure {uid:$pUid, sim:$sim, id:$pId, owner:$victim, partner:$partner, epistemic:'suggested', status:'proposed',
       title:$title, content:$content, params:$params, successCount:0, failureCount:0, round:sim.round, ts:$ts})
     CREATE (a)-[:KNOWS]->(p), (p)-[:LEARNED_FROM]->(e), (ev)-[:SUPPORTS]->(p)
     RETURN p.uid AS uid`,
    {
      simUid: simUid(sim), aUid: agentUid(sim, victim), evUid, eUid: evidenceUid, pUid, sim, pId: `P-lesson-${victim}-${defaulter}`,
      victim, partner: defaulter, title: `Lesson: secure exchanges with ${nm(defaulter)}`, content,
      params: JSON.stringify(params), ts: new Date().toISOString(),
    },
  );
  if (created.length) {
    await recordEvent(sim, {
      key: `procedure:${deal.id}:${victim}`, type: "PROCEDURE_PROPOSED", actor: "system", outcome: "confirmed",
      summary: `${nm(victim)} proposed a procedure from ${deal.id}: staged delivery with ${nm(defaulter)} (status: proposed — not yet validated)`,
      data: { procedure: pUid },
    }, [pUid]);
  }
  await q(
    `MATCH (k:Knowledge {uid:$k}), (p:Procedure {uid:$p}) MERGE (k)-[:RECOMMENDS]->(p)`,
    { k: uid(sim, `belief|${victim}|${defaulter}|reliability`), p: pUid },
  );
  return pUid;
}

/**
 * Outcome evaluation: when a deal that was produced by a decision applying a procedure is
 * fulfilled, record the success on that procedure; `proposed` → `supported`. This is the
 * only place a procedure's status is promoted.
 */
async function validateProcedures(sim: string, deal: DealView, evidenceUid: string, evUid: string): Promise<string[]> {
  const rows = await ro(
    `MATCH (dec:Decision)-[:PRODUCED]->(d:Deal {uid:$d}) MATCH (dec)-[u:USED]->(p:Procedure) WHERE u.role = 'applied'
     RETURN DISTINCT p.uid AS uid, p.status AS status, p.owner AS owner, p.title AS title`, { d: dealUid(sim, deal.id) });
  const out: string[] = [];
  for (const r of rows) {
    const key = `procval:${deal.id}:${r.uid}`;
    const done = await ro(`MATCH (e:Event {uid:$u}) RETURN e.uid AS u`, { u: uid(sim, `ev|${key}`) });
    if (done.length) continue;
    const p = evParams(sim, {
      key, type: "PROCEDURE_VALIDATED", actor: "system", outcome: "confirmed",
      summary: `Procedure "${r.title}" worked in ${deal.id} (fulfilled, no loss) — success recorded${r.status === "proposed" ? "; status proposed → supported" : ""}`,
      data: { dealId: deal.id, procedure: r.uid },
    });
    await q(
      `MATCH (sim:Simulation {uid:$simUid})
       MATCH (p:Procedure {uid:$pUid}), (evd:Evidence {uid:$eUid})
       OPTIONAL MATCH (old:Event {uid:$evUid})
       WITH sim, p, evd, old WHERE old IS NULL
       SET p.successCount = p.successCount + 1, p.status = CASE WHEN p.status = 'proposed' THEN 'supported' ELSE p.status END
       WITH sim, p, evd
       ${EVENT_CLAUSE}
       CREATE (evd)-[:SUPPORTS]->(p), (ev)-[:AFFECTED]->(p)`,
      { ...p, pUid: r.uid, eUid: evidenceUid },
    );
    out.push(r.uid);
  }
  return out;
}

// ------------------------------------------------------------------ decisions

export interface DecisionSpec {
  key: string; agent: AgentId; action: string; rationale: string; source: "policy" | "llm" | "fallback";
  memoryEnabled: boolean; respondsTo?: string; used: { uid: string; role: "applied" | "considered" }[];
  recommended?: string; llmNote?: string;
}

export async function recordDecision(sim: string, d: DecisionSpec): Promise<string> {
  const decUid = uid(sim, `dec|${d.key}`);
  await q(
    `MATCH (sim:Simulation {uid:$simUid}), (a:Agent {uid:$aUid})
     MERGE (dec:Decision {uid:$decUid})
       ON CREATE SET dec.sim=$sim, dec.id=$id, dec.agent=$agent, dec.round=sim.round, dec.session=sim.session,
         dec.action=$action, dec.rationale=$rationale, dec.source=$source, dec.memoryEnabled=$memoryEnabled,
         dec.recommended=$recommended, dec.llmNote=$llmNote, dec.ts=$ts
     MERGE (a)-[:DECIDED]->(dec)`,
    {
      simUid: simUid(sim), aUid: agentUid(sim, d.agent), decUid, sim, id: `DEC-${d.key}`, agent: d.agent, action: d.action,
      rationale: d.rationale, source: d.source, memoryEnabled: d.memoryEnabled, recommended: d.recommended ?? d.action,
      llmNote: d.llmNote ?? "", ts: new Date().toISOString(),
    },
  );
  if (d.respondsTo) {
    await q(`MATCH (dec:Decision {uid:$u}), (d:Deal {uid:$d}) MERGE (dec)-[:RESPONDS_TO]->(d)`,
      { u: decUid, d: dealUid(sim, d.respondsTo) });
  }
  if (d.used.length) {
    await q(
      `MATCH (dec:Decision {uid:$u}) UNWIND $used AS it MATCH (x {uid:it.uid, sim:$sim}) MERGE (dec)-[r:USED]->(x) SET r.role = it.role`,
      { u: decUid, used: d.used, sim },
    );
  }
  return decUid;
}

export async function linkDecisionProduced(sim: string, decUid: string, dealId: string) {
  await q(`MATCH (dec:Decision {uid:$u}), (d:Deal {uid:$d}) MERGE (dec)-[:PRODUCED]->(d)`, { u: decUid, d: dealUid(sim, dealId) });
}

export { linkAffected, AGENT_IDS };
