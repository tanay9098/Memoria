// Deterministic agent policies. Pure functions: no I/O, so they are trivially testable.
// An LLM may only choose among the `legal` options these functions produce.
import { AgentId, DealTerms, UNIT_VALUE, dealValue } from "@/lib/domain";
import type { MemoryItem } from "./memory";
import type { DealView, WorldState } from "./world";
import { nm } from "./deals";

export interface MemoryView { episodic: MemoryItem[]; beliefs: MemoryItem[]; procedures: MemoryItem[] }
export const EMPTY_MEMORY: MemoryView = { episodic: [], beliefs: [], procedures: [] };

export interface Option {
  id: string;
  label: string;
  legal: boolean;
  blockedReason?: string;
  counter?: DealTerms;
}

export interface Security {
  needed: boolean;
  applied: MemoryItem | null;     // the procedure that triggered the requirement
  considered: MemoryItem[];       // retrieved items that informed the decision without being the trigger
  belief: MemoryItem | null;
  broken: MemoryItem | null;      // most relevant broken-deal episode
  reasons: string[];
}

/**
 * Should `me` insist on staged delivery with `partner` for an exchange where `me` risks
 * `exposureValue`? All three memory types feed this one decision:
 *   episodic   – a broken deal with this partner exists (what happened)
 *   semantic   – current reliability belief for this partner (what I infer)
 *   procedural – a lesson/rule that says what to do about it
 */
export function assessSecurity(partner: AgentId, exposureValue: number, mem: MemoryView): Security {
  const belief = mem.beliefs.find((b) => b.subjects.includes(partner)) ?? null;
  const broken = mem.episodic.find((e) => e.subjects.includes(partner) && /broken|broke/i.test(e.title)) ?? null;
  const lesson = mem.procedures.find((p) => p.params?.partner === partner) ?? null;
  const generic = mem.procedures.find((p) => p.params?.partner === "*") ?? null;
  const reasons: string[] = [];
  let applied: MemoryItem | null = null;

  if (lesson && exposureValue >= (lesson.params?.minValue ?? 4)) {
    applied = lesson;
    reasons.push(`procedure "${lesson.title}" (${lesson.status}) requires staged delivery with ${nm(partner)} for exposure ≥ ${lesson.params?.minValue}`);
  } else if (
    generic && belief && belief.value !== null &&
    belief.value < (generic.params?.reliabilityThreshold ?? 0.6) && exposureValue >= (generic.params?.minValue ?? 6)
  ) {
    applied = generic;
    reasons.push(`procedure "${generic.title}" applies: reliability ${belief.value.toFixed(2)} < ${generic.params?.reliabilityThreshold} and exposure ${exposureValue} ≥ ${generic.params?.minValue}`);
  }
  if (broken) reasons.unshift(`episodic memory: ${broken.title} — "${broken.content.slice(0, 110)}…"`);
  if (belief && belief.value !== null) reasons.splice(broken ? 1 : 0, 0, `belief: ${nm(partner)} reliability ${belief.value.toFixed(2)} (${belief.status})`);
  const considered = [broken, belief, lesson, generic].filter((x): x is MemoryItem => !!x && x !== applied);
  return { needed: !!applied, applied, considered, belief, broken, reasons };
}

export interface OfferAnalysis {
  fair: boolean; affordable: boolean; exposed: boolean; exposureValue: number;
  security: Security; options: Option[]; recommended: string; rationale: string;
}

const balanceOf = (w: WorldState, a: AgentId, r: keyof WorldState["totals"]) => w.agents.find((x) => x.id === a)!.resources[r];

/** How `me` (the counterparty) should answer an offer from `deal.proposer`. */
export function analyzeOffer(me: AgentId, deal: DealView, world: WorldState, mem: MemoryView): OfferAnalysis {
  const partner = deal.proposer;
  const giveValue = dealValue(deal.getRes, deal.getQty);      // what I hand over
  const receiveValue = dealValue(deal.giveRes, deal.giveQty); // what I receive
  const fair = receiveValue >= giveValue;
  const affordable = balanceOf(world, me, deal.getRes) >= deal.getQty;
  const exposed = deal.leader !== partner;
  const security = exposed ? assessSecurity(partner, giveValue, mem) : assessSecurity(partner, 0, mem);
  const needsSecurity = exposed && security.needed;

  const staged: DealTerms = {
    proposer: me, counterparty: partner, giveRes: deal.getRes, giveQty: deal.getQty,
    getRes: deal.giveRes, getQty: deal.giveQty, deadlineRound: deal.deadlineRound, leader: partner,
    note: `Counter to ${deal.id}: ${nm(partner)} delivers first in stages`,
  };
  const options: Option[] = [];
  options.push({
    id: "accept", label: `Accept ${deal.id} as proposed`, legal: affordable && fair && !needsSecurity,
    blockedReason: !affordable ? "cannot afford" : !fair ? "terms unfair" : needsSecurity ? "violates applied procedure (no unsecured exposure)" : undefined,
  });
  options.push({ id: "reject", label: `Reject ${deal.id}`, legal: true });
  if (exposed) {
    options.push({
      id: "counter_staged", label: `Counter with staged delivery (${nm(partner)} first)`, counter: staged,
      legal: affordable && fair,
      blockedReason: !affordable ? "cannot afford" : !fair ? "terms unfair" : undefined,
    });
  }
  if (!fair && receiveValue > 0) {
    const giveQty = Math.floor(receiveValue / UNIT_VALUE[deal.getRes]);
    if (giveQty >= 1) {
      options.push({
        id: "counter_fair", label: `Counter: I give ${giveQty} ${deal.getRes} instead of ${deal.getQty}`, legal: true,
        counter: { ...staged, giveQty, leader: deal.leader, note: `Counter to ${deal.id}: fair value`, },
      });
    }
  }

  let recommended = "reject";
  let rationale = "";
  if (!affordable) rationale = `I cannot cover ${deal.getQty} ${deal.getRes}.`;
  else if (!fair) {
    const cf = options.find((o) => o.id === "counter_fair");
    recommended = cf ? "counter_fair" : "reject";
    rationale = `Value received ${receiveValue} < value given ${giveValue}; ${cf ? "asking for fair terms" : "no fair counter possible"}.`;
  } else if (needsSecurity) {
    recommended = "counter_staged";
    rationale = `Fair terms, but ${deal.leader ? "" : "unsecured and "}my exposure is ${giveValue}. ${security.reasons.join("; ")}. → insist on staged delivery, ${nm(partner)} first.`;
  } else if (!exposed) {
    recommended = "accept";
    rationale = `Fair terms and ${nm(partner)} delivers first in stages, so I carry no unsecured exposure` +
      (security.belief ? ` — ${nm(partner)}'s low reliability (${security.belief.value?.toFixed(2)}) does not block a secured deal.` : ".");
  } else {
    recommended = "accept";
    rationale = security.belief
      ? `Fair terms; exposure ${giveValue} is acceptable (${nm(partner)} reliability ${security.belief.value?.toFixed(2)}, no procedure triggered).`
      : `Fair terms (${receiveValue} ≥ ${giveValue}); no relevant memory about ${nm(partner)}.`;
  }
  return { fair, affordable, exposed, exposureValue: giveValue, security, options, recommended, rationale };
}

/** How `me` should structure a deal it proposes where it hands over `give` first-class value. */
export function chooseLeader(me: AgentId, partner: AgentId, giveValue: number, mem: MemoryView): { leader: AgentId | null; security: Security; rationale: string } {
  const security = assessSecurity(partner, giveValue, mem);
  if (security.needed) {
    return { leader: partner, security, rationale: `Proposing staged: ${security.reasons.join("; ")}.` };
  }
  return { leader: null, security, rationale: security.belief ? `${nm(partner)} reliability ${security.belief.value?.toFixed(2)}; unsecured exposure ${giveValue} acceptable.` : `No relevant memory about ${nm(partner)}.` };
}

/** Trader: does it remember defaulting? If so it rebuilds trust by delivering first. */
export function traderOffer(mem: MemoryView): { stagedLeaderTrader: boolean; rationale: string; used: MemoryItem[] } {
  const broke = mem.episodic.find((e) => /^I broke deal/.test(e.title));
  return broke
    ? { stagedLeaderTrader: true, used: [broke], rationale: `I remember breaking ${broke.dealId}; offering to deliver first to rebuild trust.` }
    : { stagedLeaderTrader: false, used: [], rationale: "No record of defaulting; standard unsecured offer." };
}

/** Plan the staged delivery sequence: leader hands over in chunks, follower matches up to the allowed fraction. */
export function stagedPlan(leaderTotal: number, followerTotal: number, stages = 2): { leader: number; follower: number }[] {
  const plan: { leader: number; follower: number }[] = [];
  let leadDone = 0, folDone = 0;
  for (let s = 1; s <= stages; s++) {
    const leadTarget = s === stages ? leaderTotal : Math.ceil((leaderTotal * s) / stages);
    const folTarget = s === stages ? followerTotal : Math.floor((followerTotal * leadTarget) / leaderTotal);
    plan.push({ leader: leadTarget - leadDone, follower: folTarget - folDone });
    leadDone = leadTarget; folDone = folTarget;
  }
  return plan.filter((p) => p.leader > 0 || p.follower > 0);
}
