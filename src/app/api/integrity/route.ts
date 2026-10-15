import { handle, getSim } from "@/server/api";
import { checkIntegrity } from "@/server/integrity";
import { requireSim } from "@/server/world";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handle(async () => {
  const sim = getSim(req);
  await requireSim(sim);
  return checkIntegrity(sim);
});
