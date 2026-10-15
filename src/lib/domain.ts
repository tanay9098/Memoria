import { z } from "zod";

export const AGENT_IDS = ["farmer", "trader", "mayor"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const RESOURCES = ["food", "wood", "tools"] as const;
export type ResourceType = (typeof RESOURCES)[number];

/** Abstract unit values used to judge whether a trade is fair. */
export const UNIT_VALUE: Record<ResourceType, number> = { food: 1, wood: 1, tools: 2 };

export const DEAL_STATES = ["proposed", "accepted", "fulfilled", "broken", "rejected", "countered"] as const;
export type DealState = (typeof DEAL_STATES)[number];

/** The only legal deal transitions; enforced with a compare-and-set in Cypher. */
export const DEAL_TRANSITIONS: Record<DealState, DealState[]> = {
  proposed: ["accepted", "rejected", "countered"],
  accepted: ["fulfilled", "broken"],
  fulfilled: [],
  broken: [],
  rejected: [],
  countered: [],
};

export const EVENT_TYPES = [
  "SIM_SEEDED", "SEASON_STARTED", "DEAL_PROPOSED", "DEAL_ACCEPTED", "DEAL_REJECTED", "DEAL_COUNTERED",
  "TRANSFER", "ALLOCATION", "DEAL_FULFILLED", "DEAL_BROKEN", "MEMORY_RETRIEVED", "MEMORY_WRITTEN",
  "TRUST_UPDATED", "PROCEDURE_PROPOSED", "PROCEDURE_VALIDATED", "SHORTAGE_RAISED", "HANDOFF_REQUESTED",
  "TASK_COMPLETED", "PLAN_COMPLETED", "SESSION_STARTED", "DECISION", "LLM_SUGGESTION", "LLM_FALLBACK",
  "ACTION_REJECTED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Feed categories: what the UI shows as a confirmed state change vs. memory vs. suggestion. */
export type EventCategory = "state" | "memory" | "coordination" | "suggestion";
export const EVENT_CATEGORY: Record<EventType, EventCategory> = {
  SIM_SEEDED: "state", SEASON_STARTED: "state", DEAL_PROPOSED: "state", DEAL_ACCEPTED: "state",
  DEAL_REJECTED: "state", DEAL_COUNTERED: "state", TRANSFER: "state", ALLOCATION: "state",
  DEAL_FULFILLED: "state", DEAL_BROKEN: "state", MEMORY_RETRIEVED: "memory", MEMORY_WRITTEN: "memory",
  TRUST_UPDATED: "memory", PROCEDURE_PROPOSED: "memory", PROCEDURE_VALIDATED: "memory",
  SHORTAGE_RAISED: "coordination", HANDOFF_REQUESTED: "coordination", TASK_COMPLETED: "coordination",
  PLAN_COMPLETED: "coordination", SESSION_STARTED: "state", DECISION: "coordination",
  LLM_SUGGESTION: "suggestion", LLM_FALLBACK: "suggestion", ACTION_REJECTED: "suggestion",
};

export const agentId = z.enum(AGENT_IDS);
export const resourceType = z.enum(RESOURCES);
const qty = z.number().int().positive().max(1000);

export const dealTermsSchema = z.object({
  proposer: agentId,
  counterparty: agentId,
  /** what the proposer hands over */
  giveRes: resourceType,
  giveQty: qty,
  /** what the counterparty hands over */
  getRes: resourceType,
  getQty: qty,
  deadlineRound: z.number().int().min(0).max(1000),
  /** party who must deliver ahead of the other (staged delivery); null = unsecured */
  leader: agentId.nullable().default(null),
  parentDealId: z.string().optional(),
  note: z.string().max(300).optional(),
}).refine((d) => d.proposer !== d.counterparty, { message: "proposer and counterparty must differ" })
  .refine((d) => d.leader === null || d.leader === d.proposer || d.leader === d.counterparty, {
    message: "leader must be one of the two parties",
  });
export type DealTerms = z.infer<typeof dealTermsSchema>;

export const respondSchema = z.discriminatedUnion("response", [
  z.object({ response: z.literal("accept") }),
  z.object({ response: z.literal("reject"), reason: z.string().max(300).optional() }),
  z.object({ response: z.literal("counter"), terms: dealTermsSchema }),
]);

export const transferActionSchema = z.object({
  kind: z.literal("TRANSFER"),
  dealId: z.string().min(1),
  from: agentId,
  qty,
  idemKey: z.string().min(1).max(120),
});
export const allocateActionSchema = z.object({
  kind: z.literal("ALLOCATE"),
  from: agentId,
  to: agentId,
  resource: resourceType,
  qty,
  idemKey: z.string().min(1).max(120),
  taskId: z.string().optional(),
});
export const actionSchema = z.discriminatedUnion("kind", [transferActionSchema, allocateActionSchema]);
export type Action = z.infer<typeof actionSchema>;

export const handoffSchema = z.object({
  from: agentId,
  to: agentId,
  kind: z.enum(["resolve_shortage", "request_proposal"]),
  payload: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.string().optional(),
  idemKey: z.string().min(1).max(120),
});

export const outcomeSchema = z.object({
  dealId: z.string().min(1),
  result: z.enum(["fulfilled", "broken"]),
  defaulter: agentId.optional(),
  reason: z.string().max(300).optional(),
});

export const dealValue = (res: ResourceType, q: number) => UNIT_VALUE[res] * q;
