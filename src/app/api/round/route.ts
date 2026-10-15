import { z } from "zod";
import { handle, simParam } from "@/server/api";
import { SCENARIOS, runNextRound } from "@/server/scenario";
import { defaultLlmClient } from "@/server/llm";
import { ValidationError } from "@/server/world";

export const dynamic = "force-dynamic";
const body = z.object({
  sim: simParam.optional(),
  memoryEnabled: z.boolean().default(true),
  llm: z.boolean().default(false),
  scenario: z.string().optional(),
  pace: z.number().int().min(0).max(1500).default(350),
});
export const POST = (req: Request) => handle(async () => {
  const b = body.parse(await req.json().catch(() => ({})));
  const sc = b.scenario ? SCENARIOS.find((s) => s.id === b.scenario) : undefined;
  if (b.scenario && !sc) throw new ValidationError(`Unknown scenario '${b.scenario}'`);
  const llm = b.llm ? defaultLlmClient() : undefined;
  if (b.llm && !llm) throw new ValidationError("LLM assist requested but ANTHROPIC_API_KEY is not configured on the server");
  return runNextRound(b.sim ?? "village-1", { memoryEnabled: b.memoryEnabled, llm, pace: b.pace }, sc);
});
