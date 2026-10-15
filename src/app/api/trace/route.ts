import { z } from "zod";
import { handle, getSim } from "@/server/api";
import { ro } from "@/lib/falkor";
import { P } from "@/server/events";
import { eventView } from "@/server/world";

export const dynamic = "force-dynamic";
/** Provenance trace for a memory/knowledge/procedure: its evidence → source events → deal events, and decisions that used it. */
export const GET = (req: Request) => handle(async () => {
  const sim = getSim(req);
  const u = z.string().min(3).max(300).parse(new URL(req.url).searchParams.get("uid"));
  const decisions = await ro(
    `MATCH (d:Decision)-[r:USED]->(x {uid:$u, sim:$sim}) OPTIONAL MATCH (d)-[:RESPONDS_TO]->(resp:Deal) OPTIONAL MATCH (d)-[:PRODUCED]->(prod:Deal)
     RETURN d, r.role AS role, resp.id AS responds, prod.id AS produced ORDER BY d.round`, { u, sim });
  const direct = await ro(`MATCH (x {uid:$u, sim:$sim})-[:LEARNED_FROM]->(e:Event) RETURN e`, { u, sim });
  const viaEvidence = await ro(`MATCH (ev:Evidence)-[:SUPPORTS]->(x {uid:$u, sim:$sim}) MATCH (ev)-[:OBSERVED_IN]->(e:Event) RETURN e`, { u, sim });
  const events = [...direct, ...viaEvidence].filter((r, i, all) => all.findIndex((o) => P(o.e).uid === P(r.e).uid) === i);
  events.sort((x, y) => P(x.e).seq - P(y.e).seq);
  return {
    decisions: decisions.map((r) => ({ ...P(r.d), role: r.role, responds: r.responds, produced: r.produced })),
    events: events.map((r) => eventView(P(r.e))),
  };
});
