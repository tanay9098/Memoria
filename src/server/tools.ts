// The eight agent tools. These are the ONLY way agents (and the MCP server) touch the
// graph; each one validates its input with zod and delegates to the same backend
// functions. No tool accepts Cypher.
import { z } from "zod";
import { agentId, actionSchema, dealTermsSchema, handoffSchema, outcomeSchema, respondSchema } from "@/lib/domain";
import { respondToDeal, proposeDeal, executeValidatedAction } from "./deals";
import { recordEvent } from "./events";
import { findRelatedEvents, getAgentMemories, recordOutcomeAndMemory } from "./memory";
import { requestHandoff } from "./tasks";
import { ValidationError, getWorldState } from "./world";

const sim = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const toolSchemas = {
  get_world_state: z.object({ sim }),
  get_agent_memories: z.object({
    sim, agent: agentId, about: agentId.optional(), kinds: z.array(z.enum(["episodic", "semantic", "procedural"])).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  find_related_events: z.object({ sim, dealId: z.string().optional(), agent: agentId.optional(), limit: z.number().int().min(1).max(100).optional() }),
  propose_deal: z.object({ sim, actor: agentId, terms: dealTermsSchema, idemKey: z.string().min(1).max(120) }),
  respond_to_deal: z.object({ sim, actor: agentId, dealId: z.string().min(1), response: respondSchema, idemKey: z.string().min(1).max(120) }),
  request_agent_handoff: z.object({ sim, actor: agentId }).merge(handoffSchema),
  execute_validated_action: z.object({ sim, actor: agentId, action: actionSchema }),
  record_outcome_and_memory: z.object({ sim }).merge(outcomeSchema),
} as const;

/** Rejected writes are themselves recorded (category "suggestion": nothing changed). */
async function guarded<T>(simId: string, tool: string, actor: string, key: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ValidationError || e instanceof z.ZodError) {
      const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e.message;
      await recordEvent(simId, {
        key: `rejected:${tool}:${key}`, type: "ACTION_REJECTED", actor, outcome: "rejected",
        summary: `Backend rejected ${tool} from ${actor}: ${msg}`, data: { tool, error: msg },
      }).catch(() => undefined);
    }
    throw e;
  }
}

export const tools = {
  get_world_state: async (a: z.input<typeof toolSchemas.get_world_state>) => getWorldState(toolSchemas.get_world_state.parse(a).sim),

  get_agent_memories: async (a: z.input<typeof toolSchemas.get_agent_memories>) => {
    const p = toolSchemas.get_agent_memories.parse(a);
    return getAgentMemories(p.sim, p.agent, { about: p.about, kinds: p.kinds, limit: p.limit });
  },

  find_related_events: async (a: z.input<typeof toolSchemas.find_related_events>) => {
    const p = toolSchemas.find_related_events.parse(a);
    return findRelatedEvents(p.sim, { dealId: p.dealId, agent: p.agent, limit: p.limit });
  },

  propose_deal: async (a: z.input<typeof toolSchemas.propose_deal>) => {
    const p = toolSchemas.propose_deal.parse(a);
    return guarded(p.sim, "propose_deal", p.actor, p.idemKey, () => proposeDeal(p.sim, p.actor, p.terms, p.idemKey));
  },

  respond_to_deal: async (a: z.input<typeof toolSchemas.respond_to_deal>) => {
    const p = toolSchemas.respond_to_deal.parse(a);
    return guarded(p.sim, "respond_to_deal", p.actor, p.idemKey, () => respondToDeal(p.sim, p.actor, p.dealId, p.response, p.idemKey));
  },

  request_agent_handoff: async (a: z.input<typeof toolSchemas.request_agent_handoff>) => {
    const p = toolSchemas.request_agent_handoff.parse(a);
    return guarded(p.sim, "request_agent_handoff", p.actor, p.idemKey, () =>
      requestHandoff(p.sim, p.actor, { from: p.from, to: p.to, kind: p.kind, payload: p.payload, dependsOn: p.dependsOn, idemKey: p.idemKey }));
  },

  execute_validated_action: async (a: z.input<typeof toolSchemas.execute_validated_action>) => {
    const p = toolSchemas.execute_validated_action.parse(a);
    return guarded(p.sim, "execute_validated_action", p.actor, p.action.idemKey, () => executeValidatedAction(p.sim, p.actor, p.action));
  },

  record_outcome_and_memory: async (a: z.input<typeof toolSchemas.record_outcome_and_memory>) => {
    const p = toolSchemas.record_outcome_and_memory.parse(a);
    return guarded(p.sim, "record_outcome_and_memory", "system", `${p.dealId}:${p.result}`, () => recordOutcomeAndMemory(p.sim, p));
  },
};

export type ToolName = keyof typeof tools;
