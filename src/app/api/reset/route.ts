import { z } from "zod";
import { handle, simParam } from "@/server/api";
import { seedSimulation } from "@/server/seed";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => handle(async () => {
  const b = z.object({ sim: simParam.optional() }).parse(await req.json().catch(() => ({})));
  const sim = b.sim ?? "village-1";
  await seedSimulation(sim);
  return { ok: true, sim };
});
