// Optional LLM assist. The LLM never touches the graph: it may only pick one of the
// options the deterministic policy already marked legal, and explain why. Any failure
// (no key, network, timeout, malformed / illegal answer) falls back to the policy.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "@/lib/config";

export interface LlmChoiceRequest {
  agent: string;
  role: string;
  goal: string;
  situation: string;
  memories: string[];
  options: { id: string; label: string }[];
}
export interface LlmChoice { optionId: string; rationale: string }
export interface LlmClient { choose(req: LlmChoiceRequest): Promise<unknown> }

const choiceSchema = z.object({ optionId: z.string().min(1), rationale: z.string().min(1).max(500) });

export function llmConfigured(): boolean {
  return !!config.llm.apiKey;
}

export function defaultLlmClient(): LlmClient | undefined {
  if (!config.llm.apiKey) return undefined;
  const anthropic = new Anthropic({ apiKey: config.llm.apiKey, timeout: 20_000, maxRetries: 1 });
  return {
    async choose(req) {
      const schema = {
        type: "object",
        properties: {
          optionId: { type: "string", enum: req.options.map((o) => o.id) },
          rationale: { type: "string" },
        },
        required: ["optionId", "rationale"],
        additionalProperties: false,
      };
      const res = await anthropic.messages.create({
        model: config.llm.model,
        max_tokens: 1024,
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        system:
          `You are the ${req.agent} (${req.role}) in a small village simulation. Goal: ${req.goal} ` +
          `Choose exactly one of the allowed options. Use only the facts and memories provided. ` +
          `Respond with JSON {optionId, rationale}; rationale ≤ 40 words and must cite the memories that matter.`,
        messages: [{
          role: "user",
          content: `Situation:\n${req.situation}\n\nRetrieved memories:\n${req.memories.length ? req.memories.map((m) => `- ${m}`).join("\n") : "(none available)"}\n\nAllowed options:\n${req.options.map((o) => `- ${o.id}: ${o.label}`).join("\n")}`,
        }],
      });
      if (res.stop_reason === "refusal") throw new Error("model refused");
      const text = res.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("no text block in response");
      return JSON.parse(text.text);
    },
  };
}

export type LlmOutcome =
  | { ok: true; choice: LlmChoice }
  | { ok: false; reason: string };

/** Call the client and validate its answer against the legal option ids. Never throws. */
export async function askLlm(client: LlmClient, req: LlmChoiceRequest): Promise<LlmOutcome> {
  try {
    const raw = await Promise.race([
      client.choose(req),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("LLM timeout after 25s")), 25_000)),
    ]);
    const parsed = choiceSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `malformed LLM output: ${parsed.error.issues[0]?.message}` };
    if (!req.options.some((o) => o.id === parsed.data.optionId)) {
      return { ok: false, reason: `LLM chose "${parsed.data.optionId}", which is not an allowed action` };
    }
    return { ok: true, choice: parsed.data };
  } catch (e) {
    return { ok: false, reason: `LLM request failed: ${(e as Error).message}` };
  }
}
