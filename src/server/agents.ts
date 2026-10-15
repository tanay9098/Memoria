// Agent orchestration: retrieve from the graph → run deterministic policy → (optionally) let an
// LLM pick among legal options → record the decision with provenance → act through the tools.
import { AgentId, dealValue } from "@/lib/domain";
import { tools } from "./tools";
import { recordEvent } from "./events";
import { MemoryItem, linkDecisionProduced, recordDecision } from "./memory";
import { EMPTY_MEMORY, MemoryView, OfferAnalysis, Option, analyzeOffer, chooseLeader, stagedPlan } from "./policy";
import { DealView, getDeal, getWorldState, setAgentStatus, ValidationError, agentUid } from "./world";
import { askLlm, LlmClient } from "./llm";
import { nm, describeTerms } from "./deals";
import { recordOutcomeAndMemory } from "./memory";

export interface RunOpts {
  /** Memory retrieval enabled for the decisions of this round (Mode A) or disabled (Mode B). */
  memoryEnabled: boolean;
  llm?: LlmClient | null;
  /** Milliseconds to pause between agent steps so the UI can show live progress. */
  pace?: number;
}
export const sleep = (ms?: number) => (ms ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

function toView(items: MemoryItem[], partner: string): MemoryView {
  if (partner === "*") {
    return { episodic: items.filter((i) => i.kind === "episodic"), beliefs: items.filter((i) => i.kind === "semantic"), procedures: items.filter((i) => i.kind === "procedural") };
  }
  return {
    episodic: items.filter((i) => i.kind === "episodic" && i.subjects.includes(partner)),
    beliefs: items.filter((i) => i.kind === "semantic" && i.subjects.includes(partner)),
    procedures: items.filter((i) => i.kind === "procedural" && (i.params?.partner === "*" || i.params?.partner === partner)),
  };
}

export interface Retrieval { view: MemoryView; items: MemoryItem[] }

/** get_agent_memories + a MEMORY_RETRIEVED event so retrieval is visible and auditable. */
export async function retrieve(sim: string, me: AgentId, partner: string, opts: RunOpts, key: string): Promise<Retrieval> {
  if (!opts.memoryEnabled) {
    await recordEvent(sim, {
      key: `retrieve:${key}`, type: "MEMORY_RETRIEVED", actor: me, outcome: "disabled",
      summary: `${nm(me)}: memory retrieval DISABLED (evaluation mode B) — deciding from current world state only`,
      data: { partner, disabled: true },
    });
    return { view: EMPTY_MEMORY, items: [] };
  }
  const all = await tools.get_agent_memories({ sim, agent: me });
  const view = toView(all, partner);
  const items = [...view.episodic, ...view.beliefs, ...view.procedures];
  await recordEvent(sim, {
    key: `retrieve:${key}`, type: "MEMORY_RETRIEVED", actor: me, outcome: "confirmed",
    summary: `${nm(me)} retrieved ${items.length} memories${partner === "*" ? "" : ` about ${nm(partner)}`} from the graph ` +
      `(${view.episodic.length} episodic, ${view.beliefs.length} semantic, ${view.procedures.length} procedural)`,
    data: { partner, items: items.map((i) => ({ uid: i.uid, kind: i.kind, title: i.title })) },
  }, items.map((i) => i.uid));
  return { view, items };
}

export interface OfferDecision {
  analysis: OfferAnalysis;
  option: Option;
  decisionUid: string;
  source: "policy" | "llm" | "fallback";
}

/** Decide how to answer `deal`, record the decision and its memory provenance. */
export async function decideOffer(sim: string, me: AgentId, deal: DealView, opts: RunOpts, key: string): Promise<OfferDecision> {
  await setAgentStatus(sim, me, "thinking");
  await sleep(opts.pace);
  const world = await getWorldState(sim);
  const { view } = await retrieve(sim, me, deal.proposer, opts, key);
  const analysis = analyzeOffer(me, deal, world, view);
  let option = analysis.options.find((o) => o.id === analysis.recommended)!;
  let source: OfferDecision["source"] = "policy";
  let llmNote = "";

  if (opts.llm) {
    const legal = analysis.options.filter((o) => o.legal);
    const res = await askLlm(opts.llm, {
      agent: nm(me), role: world.agents.find((a) => a.id === me)!.role, goal: world.agents.find((a) => a.id === me)!.goal,
      situation: `${nm(deal.proposer)} offers ${deal.id}: ${describeTerms(deal)}; ${deal.leader ? `${nm(deal.leader)} delivers first` : "unsecured"}; due round ${deal.deadlineRound}. ` +
        `My stock: ${JSON.stringify(world.agents.find((a) => a.id === me)!.resources)}.`,
      memories: [...view.episodic, ...view.beliefs, ...view.procedures].map((m) => `[${m.kind}] ${m.title}: ${m.content}`),
      options: legal.map((o) => ({ id: o.id, label: o.label })),
    });
    if (res.ok) {
      const picked = legal.find((o) => o.id === res.choice.optionId)!;
      llmNote = res.choice.rationale;
      source = "llm";
      option = picked;
      await recordEvent(sim, {
        key: `llm:${key}`, type: "LLM_SUGGESTION", actor: me, outcome: picked.id === analysis.recommended ? "agrees_with_policy" : "differs_from_policy",
        summary: `LLM suggested "${picked.id}" for ${nm(me)} (policy: "${analysis.recommended}") — validated against legal options, then applied`,
        data: { suggestion: picked.id, policy: analysis.recommended, rationale: res.choice.rationale },
      });
    } else {
      source = "fallback";
      await recordEvent(sim, {
        key: `llm:${key}`, type: "LLM_FALLBACK", actor: me, outcome: "fallback",
        summary: `LLM unavailable for ${nm(me)} — deterministic policy used (${res.reason})`, data: { reason: res.reason },
      });
    }
  }

  const sec = analysis.security;
  const used = [
    ...(sec.applied ? [{ uid: sec.applied.uid, role: "applied" as const }] : []),
    ...sec.considered.map((m) => ({ uid: m.uid, role: "considered" as const })),
  ];
  const decisionUid = await recordDecision(sim, {
    key, agent: me, action: option.id, rationale: analysis.rationale, source, memoryEnabled: opts.memoryEnabled,
    respondsTo: deal.id, used, recommended: analysis.recommended, llmNote,
  });
  await recordEvent(sim, {
    key: `decision:${key}`, type: "DECISION", actor: me, outcome: "confirmed",
    summary: `${nm(me)} decided to ${option.id.replace("_", " ")} on ${deal.id}: ${analysis.rationale}`,
    data: { decision: decisionUid, option: option.id, memoryEnabled: opts.memoryEnabled, source },
  }, [decisionUid]);
  return { analysis, option, decisionUid, source };
}

/** Apply an OfferDecision through the validated tools. Returns the resulting deal (original or counter). */
export async function applyOfferDecision(
  sim: string, me: AgentId, deal: DealView, d: OfferDecision, key: string,
): Promise<{ deal: DealView; counter?: DealView }> {
  if (d.option.id === "accept") {
    const r = await tools.respond_to_deal({ sim, actor: me, dealId: deal.id, response: { response: "accept" }, idemKey: key });
    return { deal: r.deal };
  }
  if (d.option.id === "reject") {
    const r = await tools.respond_to_deal({ sim, actor: me, dealId: deal.id, response: { response: "reject", reason: d.analysis.rationale.slice(0, 200) }, idemKey: key });
    return { deal: r.deal };
  }
  if (!d.option.counter) throw new ValidationError(`Option ${d.option.id} has no counter terms`);
  const r = await tools.respond_to_deal({ sim, actor: me, dealId: deal.id, response: { response: "counter", terms: d.option.counter }, idemKey: key });
  await linkDecisionProduced(sim, d.decisionUid, r.counter!.id);
  return { deal: r.deal, counter: r.counter };
}

/** Decide the shape of a deal `me` is about to propose (unsecured vs partner-first). */
export async function decideProposal(
  sim: string, me: AgentId, partner: AgentId,
  give: { res: "food" | "wood" | "tools"; qty: number }, get: { res: "food" | "wood" | "tools"; qty: number },
  deadlineRound: number, opts: RunOpts, key: string, note: string,
): Promise<DealView> {
  await setAgentStatus(sim, me, "thinking");
  await sleep(opts.pace);
  const { view } = await retrieve(sim, me, partner, opts, key);
  const exposure = dealValue(give.res, give.qty);
  const lead = chooseLeader(me, partner, exposure, view);
  const sec = lead.security;
  const decisionUid = await recordDecision(sim, {
    key, agent: me, action: lead.leader ? "propose_staged" : "propose_unsecured", rationale: lead.rationale,
    source: "policy", memoryEnabled: opts.memoryEnabled,
    used: [
      ...(sec.applied ? [{ uid: sec.applied.uid, role: "applied" as const }] : []),
      ...sec.considered.map((m) => ({ uid: m.uid, role: "considered" as const })),
    ],
  });
  const r = await tools.propose_deal({
    sim, actor: me, idemKey: key,
    terms: { proposer: me, counterparty: partner, giveRes: give.res, giveQty: give.qty, getRes: get.res, getQty: get.qty,
      deadlineRound, leader: lead.leader, note },
  });
  await linkDecisionProduced(sim, decisionUid, r.deal.id);
  return r.deal;
}

/**
 * Carry out an accepted deal using execute_validated_action. `defaulter` models a scripted
 * failure: that party simply never delivers (the backend would still accept their delivery).
 */
export async function executeDeal(
  sim: string, dealId: string, opts: { pace?: number; defaulter?: AgentId } = {},
): Promise<DealView> {
  let deal = await getDeal(sim, dealId);
  if (deal.state !== "accepted") throw new ValidationError(`${dealId} is ${deal.state}; nothing to execute`);
  const moves: { from: AgentId; qty: number; tag: string }[] = [];
  if (deal.leader) {
    const leaderIsProposer = deal.leader === deal.proposer;
    const plan = stagedPlan(leaderIsProposer ? deal.giveQty : deal.getQty, leaderIsProposer ? deal.getQty : deal.giveQty);
    const follower = leaderIsProposer ? deal.counterparty : deal.proposer;
    plan.forEach((p, i) => {
      if (p.leader) moves.push({ from: deal.leader as AgentId, qty: p.leader, tag: `s${i + 1}L` });
      if (p.follower) moves.push({ from: follower, qty: p.follower, tag: `s${i + 1}F` });
    });
  } else {
    moves.push({ from: deal.proposer, qty: deal.giveQty, tag: "P" }, { from: deal.counterparty, qty: deal.getQty, tag: "C" });
  }
  for (const m of moves) {
    if (m.from === opts.defaulter) continue;
    await sleep(opts.pace);
    await setAgentStatus(sim, m.from, "acting");
    await tools.execute_validated_action({
      sim, actor: m.from, action: { kind: "TRANSFER", dealId, from: m.from, qty: m.qty, idemKey: `exec:${dealId}:${m.tag}` },
    });
  }
  deal = await getDeal(sim, dealId);
  if (deal.state === "fulfilled") await recordOutcomeAndMemory(sim, { dealId, result: "fulfilled" });
  return deal;
}

export { agentUid };
