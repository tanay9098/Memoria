import { z } from "zod";
import { handle, getSim } from "@/server/api";
import { agentId } from "@/lib/domain";
import { tools } from "@/server/tools";
import { requireSim } from "@/server/world";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handle(async () => {
  const sim = getSim(req);
  const agent = agentId.parse(new URL(req.url).searchParams.get("agent"));
  await requireSim(sim);
  return { agent, memories: await tools.get_agent_memories({ sim, agent }) };
});
