import { q, ro, uid } from "@/lib/falkor";
import {
  Action, DEAL_TRANSITIONS, DealState, DealTerms, RESOURCES, ResourceType, allocateActionSchema, dealTermsSchema,
  respondSchema, transferActionSchema,
} from "@/lib/domain";
import { z } from "zod";
import { EVENT_CLAUSE, evParams, P } from "./events";
import {
  DealView, NotFoundError, ValidationError, agentUid, dealUid, dealView, getDeal, resUid, simUid, requireSim,
} from "./world";

export const nm = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
export const describeTerms = (t: Pick<DealView, "proposer" | "counterparty" | "giveRes" | "giveQty" | "getRes" | "getQty">) =>
  `${nm(t.proposer)} gives ${t.giveQty} ${t.giveRes} ⇄ ${nm(t.counterparty)} gives ${t.getQty} ${t.getRes}`;

async function balance(sim: string, agent: string, res: ResourceType): Promise<number> {
  const r = await ro(`MATCH (r:Resource {uid:$u}) RETURN r.qty AS qty`, { u: resUid(sim, agent, res) });
  if (!r.length) throw new NotFoundError(`Resource ${res} of ${agent}`);
  return r[0].qty;
}

async function eventExists(sim: string, key: string) {
  const r = await ro(`MATCH (e:Event {uid:$u}) RETURN e.uid AS uid`, { u: uid(sim, `ev|${key}`) });
  return r.length > 0;
}

export interface ProposeResult { deal: DealView; replayed: boolean }

// ---------------------------------------------------------------- propose_deal

export async function proposeDeal(
  sim: string, actor: string, rawTerms: unknown, idemKey: string,
): Promise<ProposeResult> {
  await requireSim(sim);
  const terms = dealTermsSchema.parse(rawTerms);
  if (terms.proposer !== actor) throw new ValidationError(`${actor} cannot propose a deal on behalf of ${terms.proposer}`);

  const evKey = `propose:${idemKey}`;
  const replay = await findDealByEvent(sim, evKey);
  if (replay) return { deal: replay, replayed: true };

  const have = await balance(sim, terms.proposer, terms.giveRes);
  if (have < terms.giveQty) {
    throw new ValidationError(`${nm(terms.proposer)} only holds ${have} ${terms.giveRes}; deal requires ${terms.giveQty}`);
  }
  let parent: DealView | null = null;
  if (terms.parentDealId) {
    parent = await getDeal(sim, terms.parentDealId);
    if (parent.state !== "proposed") throw new ValidationError(`Cannot counter ${parent.id}: state is ${parent.state}`);
    if (parent.counterparty !== actor) throw new ValidationError(`Only ${nm(parent.counterparty)} can counter ${parent.id}`);
  }

  const summary = `${nm(actor)} ${parent ? "countered" : "proposed"} ${describeTerms(terms)}` +
    `${terms.leader ? ` — staged, ${nm(terms.leader)} delivers first` : " — unsecured"} (due round ${terms.deadlineRound})`;
  const p = evParams(sim, {
    key: evKey, type: parent ? "DEAL_COUNTERED" : "DEAL_PROPOSED", actor, outcome: "confirmed", summary,
    data: { terms },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid})
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, old WHERE old IS NULL
     ${parent ? "MATCH (parent:Deal {uid:$parentUid}) WHERE parent.state = 'proposed' SET parent.state = 'countered'" : ""}
     SET sim.dealSeq = sim.dealSeq + 1
     CREATE (d:Deal {uid: sim.id + '|deal|D-' + toString(sim.dealSeq), id: 'D-' + toString(sim.dealSeq), n: sim.dealSeq,
       sim:$sim, state:'proposed', proposer:$proposer, counterparty:$counterparty, giveRes:$giveRes, giveQty:$giveQty,
       getRes:$getRes, getQty:$getQty, proposerDelivered:0, counterpartyDelivered:0, deadlineRound:$deadline,
       leader:$leader, createdRound:sim.round, parentDealId:$parentId, note:$note, defaulter:''})
     CREATE (sim)-[:HAS_DEAL]->(d)
     WITH sim, d${parent ? ", parent" : ""}
     MATCH (pa:Agent {uid:$proposerUid}), (ca:Agent {uid:$counterUid})
     CREATE (pa)-[:PROPOSED]->(d), (d)-[:WITH]->(ca)
     ${parent ? "CREATE (d)-[:COUNTERS]->(parent)" : ""}
     WITH sim, d, pa
     ${EVENT_CLAUSE}
     CREATE (pa)-[:PERFORMED]->(ev), (ev)-[:AFFECTED]->(d)
     RETURN d`,
    {
      ...p, proposer: terms.proposer, counterparty: terms.counterparty, giveRes: terms.giveRes, giveQty: terms.giveQty,
      getRes: terms.getRes, getQty: terms.getQty, deadline: terms.deadlineRound, leader: terms.leader ?? "",
      parentId: terms.parentDealId ?? "", note: terms.note ?? "", parentUid: parent ? dealUid(sim, parent.id) : "",
      proposerUid: agentUid(sim, terms.proposer), counterUid: agentUid(sim, terms.counterparty),
    },
  );
  if (!rows.length) {
    const again = await findDealByEvent(sim, evKey);
    if (again) return { deal: again, replayed: true };
    throw new ValidationError("Proposal was not applied (conflicting concurrent change)");
  }
  return { deal: dealView(P(rows[0].d)), replayed: false };
}

async function findDealByEvent(sim: string, evKey: string): Promise<DealView | null> {
  const r = await ro(
    `MATCH (e:Event {uid:$u})-[:AFFECTED]->(d:Deal) RETURN d ORDER BY d.n DESC LIMIT 1`,
    { u: uid(sim, `ev|${evKey}`) },
  );
  return r.length ? dealView(P(r[0].d)) : null;
}

// ---------------------------------------------------------------- respond_to_deal

export type RespondResult = { deal: DealView; replayed: boolean; counter?: DealView };

export async function respondToDeal(
  sim: string, actor: string, dealId: string, rawResponse: unknown, idemKey: string,
): Promise<RespondResult> {
  await requireSim(sim);
  const response = respondSchema.parse(rawResponse);
  const deal = await getDeal(sim, dealId);
  const evKey = `respond:${idemKey}`;

  if (response.response === "counter") {
    const terms = response.terms;
    if (terms.proposer !== actor || terms.counterparty !== deal.proposer) {
      throw new ValidationError(`A counter to ${dealId} must be proposed by ${nm(actor)} to ${nm(deal.proposer)}`);
    }
    const res = await proposeDeal(sim, actor, { ...terms, parentDealId: dealId }, idemKey);
    return { deal: await getDeal(sim, dealId), replayed: res.replayed, counter: res.deal };
  }

  if (deal.counterparty !== actor) throw new ValidationError(`Only ${nm(deal.counterparty)} can respond to ${dealId}`);
  const target: DealState = response.response === "accept" ? "accepted" : "rejected";
  if (await eventExists(sim, evKey)) return { deal, replayed: true };
  if (!DEAL_TRANSITIONS[deal.state].includes(target)) {
    throw new ValidationError(`Illegal transition ${deal.state} → ${target} for ${dealId}`);
  }
  if (target === "accepted") {
    const have = await balance(sim, deal.counterparty, deal.getRes);
    if (have < deal.getQty) {
      throw new ValidationError(`${nm(actor)} only holds ${have} ${deal.getRes}; ${dealId} requires ${deal.getQty}`);
    }
  }
  const summary = target === "accepted"
    ? `${nm(actor)} accepted ${dealId} (${describeTerms(deal)})`
    : `${nm(actor)} rejected ${dealId}${"reason" in response && response.reason ? `: ${response.reason}` : ""}`;
  const p = evParams(sim, {
    key: evKey, type: target === "accepted" ? "DEAL_ACCEPTED" : "DEAL_REJECTED", actor, outcome: "confirmed", summary,
    data: { dealId },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid})
     MATCH (d:Deal {uid:$dealUid}) WHERE d.state = 'proposed' AND d.counterparty = $actor
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, d, old WHERE old IS NULL
     SET d.state = $target
     WITH sim, d
     ${EVENT_CLAUSE}
     WITH ev, d
     MATCH (a:Agent {uid:$actorUid})
     CREATE (a)-[:${target === "accepted" ? "ACCEPTED" : "REJECTED"}]->(d), (a)-[:PERFORMED]->(ev), (ev)-[:AFFECTED]->(d)
     RETURN d`,
    { ...p, dealUid: dealUid(sim, dealId), actor, target, actorUid: agentUid(sim, actor) },
  );
  if (!rows.length) {
    if (await eventExists(sim, evKey)) return { deal: await getDeal(sim, dealId), replayed: true };
    const now = await getDeal(sim, dealId);
    throw new ValidationError(`${dealId} is ${now.state}; cannot ${response.response} (concurrent change)`);
  }
  return { deal: dealView(P(rows[0].d)), replayed: false };
}

// ---------------------------------------------------------------- execute_validated_action

export interface ActionResult {
  ok: true; replayed: boolean; kind: Action["kind"]; resource: ResourceType; qty: number; from: string; to: string;
  srcAfter?: number; dstAfter?: number; deal?: DealView;
}

export async function executeValidatedAction(sim: string, actor: string, raw: unknown): Promise<ActionResult> {
  await requireSim(sim);
  const parsed = z.discriminatedUnion("kind", [transferActionSchema, allocateActionSchema]).parse(raw);
  if (parsed.from !== actor) throw new ValidationError(`${actor} cannot move resources owned by ${parsed.from}`);
  return parsed.kind === "TRANSFER" ? doTransfer(sim, parsed) : doAllocate(sim, parsed);
}

async function doTransfer(sim: string, a: z.infer<typeof transferActionSchema>): Promise<ActionResult> {
  const deal = await getDeal(sim, a.dealId);
  const evKey = `transfer:${a.idemKey}`;
  const side = a.from === deal.proposer ? "proposer" : a.from === deal.counterparty ? "counterparty" : null;
  if (!side) throw new ValidationError(`${a.from} is not a party to ${a.dealId}`);
  const res = side === "proposer" ? deal.giveRes : deal.getRes;
  const to = side === "proposer" ? deal.counterparty : deal.proposer;
  const total = side === "proposer" ? deal.giveQty : deal.getQty;
  const delivered = side === "proposer" ? deal.proposerDelivered : deal.counterpartyDelivered;
  const base: ActionResult = { ok: true, replayed: false, kind: "TRANSFER", resource: res, qty: a.qty, from: a.from, to };

  if (await eventExists(sim, evKey)) return { ...base, replayed: true, deal: await getDeal(sim, a.dealId) };
  if (deal.state !== "accepted") throw new ValidationError(`${a.dealId} is ${deal.state}; transfers need an accepted deal`);
  if (delivered + a.qty > total) throw new ValidationError(`Transfer exceeds remaining obligation on ${a.dealId} (${total - delivered} left)`);

  // Field names come from this closed pair, never from user input.
  const [dField, tField] = side === "proposer" ? ["proposerDelivered", "giveQty"] : ["counterpartyDelivered", "getQty"];
  const p = evParams(sim, {
    key: evKey, type: "TRANSFER", actor: a.from, outcome: "confirmed",
    summary: `${nm(a.from)} delivered ${a.qty} ${res} to ${nm(to)} for ${a.dealId}`,
    data: { dealId: a.dealId, from: a.from, to, resource: res, qty: a.qty },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid})
     MATCH (d:Deal {uid:$dealUid})
     MATCH (src:Resource {uid:$srcUid}), (dst:Resource {uid:$dstUid})
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, d, src, dst, old,
          CASE WHEN d.leader = d.proposer THEN d.proposerDelivered ELSE d.counterpartyDelivered END AS leadDone,
          CASE WHEN d.leader = d.proposer THEN d.giveQty ELSE d.getQty END AS leadTotal
     WHERE old IS NULL AND d.state = 'accepted' AND src.qty >= $qty
       AND d.${dField} + $qty <= d.${tField}
       AND (d.leader = '' OR d.leader = $from OR (d.${dField} + $qty) * leadTotal <= leadDone * d.${tField})
     SET src.qty = src.qty - $qty, dst.qty = dst.qty + $qty, d.${dField} = d.${dField} + $qty
     WITH sim, d, src, dst
     SET d.state = CASE WHEN d.proposerDelivered >= d.giveQty AND d.counterpartyDelivered >= d.getQty
                        THEN 'fulfilled' ELSE d.state END
     WITH sim, d, src, dst
     ${EVENT_CLAUSE}
     SET ev.srcAfter = src.qty, ev.dstAfter = dst.qty
     WITH ev, d, src, dst
     MATCH (a:Agent {uid:$actorUid})
     CREATE (a)-[:PERFORMED]->(ev), (ev)-[:AFFECTED]->(d), (ev)-[:AFFECTED]->(src), (ev)-[:AFFECTED]->(dst)
     RETURN src.qty AS srcAfter, dst.qty AS dstAfter, d.state AS state`,
    {
      ...p, dealUid: dealUid(sim, a.dealId), srcUid: resUid(sim, a.from, res), dstUid: resUid(sim, to, res),
      qty: a.qty, from: a.from, actorUid: agentUid(sim, a.from),
    },
  );
  if (rows.length) {
    return { ...base, srcAfter: rows[0].srcAfter, dstAfter: rows[0].dstAfter, deal: await getDeal(sim, a.dealId) };
  }
  // No row: replay, or one of the guards failed. Work out which, for a precise error.
  if (await eventExists(sim, evKey)) return { ...base, replayed: true, deal: await getDeal(sim, a.dealId) };
  const have = await balance(sim, a.from, res);
  if (have < a.qty) throw new ValidationError(`${nm(a.from)} has insufficient ${res}: ${have} < ${a.qty}`);
  const now = await getDeal(sim, a.dealId);
  if (now.state !== "accepted") throw new ValidationError(`${a.dealId} is now ${now.state}`);
  if (now.leader && now.leader !== a.from) {
    throw new ValidationError(`Staged delivery: ${nm(now.leader)} must deliver ahead of ${nm(a.from)} on ${a.dealId}`);
  }
  throw new ValidationError(`Transfer on ${a.dealId} rejected (obligation already met or concurrent change)`);
}

async function doAllocate(sim: string, a: z.infer<typeof allocateActionSchema>): Promise<ActionResult> {
  if (a.from !== "mayor") throw new ValidationError("Only the Mayor may allocate from the village store");
  if (a.to === a.from) throw new ValidationError("Cannot allocate to self");
  const evKey = `allocate:${a.idemKey}`;
  const base: ActionResult = { ok: true, replayed: false, kind: "ALLOCATE", resource: a.resource, qty: a.qty, from: a.from, to: a.to };
  if (await eventExists(sim, evKey)) return { ...base, replayed: true };
  const p = evParams(sim, {
    key: evKey, type: "ALLOCATION", actor: a.from, outcome: "confirmed",
    summary: `${nm(a.from)} allocated ${a.qty} ${a.resource} to ${nm(a.to)} from the village store`,
    data: { from: a.from, to: a.to, resource: a.resource, qty: a.qty, taskId: a.taskId },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid})
     MATCH (src:Resource {uid:$srcUid}), (dst:Resource {uid:$dstUid})
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, src, dst, old WHERE old IS NULL AND src.qty >= $qty
     SET src.qty = src.qty - $qty, dst.qty = dst.qty + $qty
     WITH sim, src, dst
     ${EVENT_CLAUSE}
     SET ev.srcAfter = src.qty, ev.dstAfter = dst.qty
     WITH ev, src, dst
     MATCH (a:Agent {uid:$actorUid})
     CREATE (a)-[:PERFORMED]->(ev), (ev)-[:AFFECTED]->(src), (ev)-[:AFFECTED]->(dst)
     RETURN src.qty AS srcAfter, dst.qty AS dstAfter`,
    { ...p, srcUid: resUid(sim, a.from, a.resource), dstUid: resUid(sim, a.to, a.resource), qty: a.qty, actorUid: agentUid(sim, a.from) },
  );
  if (rows.length) return { ...base, srcAfter: rows[0].srcAfter, dstAfter: rows[0].dstAfter };
  if (await eventExists(sim, evKey)) return { ...base, replayed: true };
  const have = await balance(sim, a.from, a.resource);
  throw new ValidationError(`${nm(a.from)} has insufficient ${a.resource}: ${have} < ${a.qty}`);
}

// ---------------------------------------------------------------- broken-deal transition

/** accepted → broken, atomically with its DEAL_BROKEN event. Used by record_outcome_and_memory. */
export async function markDealBroken(
  sim: string, dealId: string, defaulter: string, reason: string,
): Promise<{ replayed: boolean; deal: DealView }> {
  const deal = await getDeal(sim, dealId);
  const evKey = `outcome:${dealId}:broken`;
  if (await eventExists(sim, evKey)) return { replayed: true, deal };
  if (!DEAL_TRANSITIONS[deal.state].includes("broken")) {
    throw new ValidationError(`Illegal transition ${deal.state} → broken for ${dealId}`);
  }
  if (defaulter !== deal.proposer && defaulter !== deal.counterparty) {
    throw new ValidationError(`${defaulter} is not a party to ${dealId}`);
  }
  const owed = defaulter === deal.proposer ? deal.giveQty - deal.proposerDelivered : deal.getQty - deal.counterpartyDelivered;
  if (owed <= 0) throw new ValidationError(`${nm(defaulter)} has nothing outstanding on ${dealId}; it cannot be broken by them`);
  const sim0 = await ro(`MATCH (s:Simulation {uid:$u}) RETURN s.round AS round`, { u: simUid(sim) });
  if (sim0[0].round < deal.deadlineRound) {
    throw new ValidationError(`${dealId} deadline is round ${deal.deadlineRound}; cannot be broken in round ${sim0[0].round}`);
  }
  const p = evParams(sim, {
    key: evKey, type: "DEAL_BROKEN", actor: "system", outcome: "confirmed",
    summary: `${dealId} BROKEN: ${nm(defaulter)} failed to deliver ${owed} ${defaulter === deal.proposer ? deal.giveRes : deal.getRes} by round ${deal.deadlineRound}`,
    data: { dealId, defaulter, owed, reason },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid})
     MATCH (d:Deal {uid:$dealUid}) WHERE d.state = 'accepted'
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, d, old WHERE old IS NULL
     SET d.state = 'broken', d.defaulter = $defaulter, d.brokenRound = sim.round
     WITH sim, d
     ${EVENT_CLAUSE}
     WITH ev, d
     MATCH (a:Agent {uid:$defUid})
     CREATE (a)-[:BROKEN]->(d), (ev)-[:AFFECTED]->(d), (ev)-[:AFFECTED]->(a)
     RETURN d`,
    { ...p, dealUid: dealUid(sim, dealId), defaulter, defUid: agentUid(sim, defaulter) },
  );
  if (!rows.length) {
    if (await eventExists(sim, evKey)) return { replayed: true, deal: await getDeal(sim, dealId) };
    throw new ValidationError(`${dealId} could not be marked broken (concurrent change)`);
  }
  return { replayed: false, deal: dealView(P(rows[0].d)) };
}

export { RESOURCES };
