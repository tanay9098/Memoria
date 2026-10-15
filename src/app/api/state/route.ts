import { handle, getSim } from "@/server/api";
import { getEvents, getWorldState } from "@/server/world";
import { ROUND_TITLES, SCENARIOS } from "@/server/scenario";

export const dynamic = "force-dynamic";
export const GET = (req: Request) => handle(async () => {
  const sim = getSim(req);
  const [world, events] = await Promise.all([getWorldState(sim), getEvents(sim, { limit: 120 })]);
  return { world, events, rounds: ROUND_TITLES, scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title })) };
});
