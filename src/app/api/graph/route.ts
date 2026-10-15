import { handle, getSim } from "@/server/api";
import { ro } from "@/lib/falkor";
import { requireSim } from "@/server/world";

export const dynamic = "force-dynamic";

const NODE_LABELS = ["Agent", "Deal", "Event", "Memory", "Knowledge", "Procedure", "Evidence", "Decision", "Task"];
const EDGE_TYPES = [
  "PROPOSED", "ACCEPTED", "REJECTED", "BROKEN", "WITH", "COUNTERS", "REMEMBERS", "BELIEVES", "KNOWS", "ABOUT",
  "LEARNED_FROM", "SUPPORTS", "RECOMMENDS", "OBSERVED_IN", "DECIDED", "USED", "RESPONDS_TO", "PRODUCED",
  "HANDED_OFF_TO", "ASSIGNED_TO", "DEPENDS_ON", "AFFECTED",
];
// Only outcome events become graph nodes (transfers etc. would drown the picture).
const EVENT_TYPES = ["DEAL_BROKEN", "DEAL_FULFILLED"];

const labelOf = (kind: string, p: any): string => {
  switch (kind) {
    case "Agent": return p.name;
    case "Deal": return `${p.id} · ${p.state}`;
    case "Event": return `${p.type === "DEAL_BROKEN" ? "Broken" : "Fulfilled"} · r${p.round}`;
    case "Memory": return p.title;
    case "Knowledge": return `${p.owner}→${p.subject} ${Number(p.value).toFixed(2)}`;
    case "Procedure": return `${p.title} · ${p.status}`;
    case "Evidence": return p.id;
    case "Decision": return `${p.agent}: ${p.action}`;
    case "Task": return `${p.id} · ${p.kind}`;
    default: return p.uid;
  }
};

export const GET = (req: Request) => handle(async () => {
  const sim = getSim(req);
  await requireSim(sim);
  const rows = await ro(
    `MATCH (a {sim:$sim})-[r]->(b {sim:$sim})
     WHERE labels(a)[0] IN $labels AND labels(b)[0] IN $labels AND type(r) IN $types
       AND (labels(a)[0] <> 'Event' OR a.type IN $evTypes) AND (labels(b)[0] <> 'Event' OR b.type IN $evTypes)
     RETURN a, labels(a)[0] AS ak, type(r) AS t, b, labels(b)[0] AS bk, r.role AS role`,
    { sim, labels: NODE_LABELS, types: EDGE_TYPES, evTypes: EVENT_TYPES },
  );
  const nodes = new Map<string, { id: string; kind: string; label: string; status?: string; round?: number; agent?: string }>();
  const edges = new Map<string, { id: string; source: string; target: string; type: string; role?: string }>();
  const add = (n: any, kind: string) => {
    const p = n.properties;
    if (!nodes.has(p.uid)) nodes.set(p.uid, { id: p.uid, kind, label: labelOf(kind, p), status: p.status ?? p.state, round: p.round, agent: p.agent ?? p.owner });
  };
  for (const r of rows) {
    add(r.a, r.ak); add(r.b, r.bk);
    const id = `${r.a.properties.uid}-${r.t}-${r.b.properties.uid}`;
    edges.set(id, { id, source: r.a.properties.uid, target: r.b.properties.uid, type: r.t, role: r.role ?? undefined });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
});
