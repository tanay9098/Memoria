import { z } from "zod";
import { handle, simParam } from "@/server/api";
import { startNewSession } from "@/server/scenario";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => handle(async () => {
  const b = z.object({ sim: simParam.optional() }).parse(await req.json().catch(() => ({})));
  return startNewSession(b.sim ?? "village-1");
});
