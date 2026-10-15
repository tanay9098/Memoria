import { handle, getSim } from "@/server/api";
import { ping } from "@/lib/falkor";
import { config } from "@/lib/config";
import { llmConfigured } from "@/server/llm";
import { simExists } from "@/server/world";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handle(async () => {
  const db = await ping();
  const sim = getSim(req);
  return {
    falkordb: { ...db, host: `${config.falkor.host}:${config.falkor.port}`, graph: config.falkor.graph },
    llm: { configured: llmConfigured(), model: llmConfigured() ? config.llm.model : null },
    simulation: { id: sim, exists: db.ok ? await simExists(sim) : false },
  };
});
