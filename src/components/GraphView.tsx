"use client";
import { useEffect, useMemo, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "./api";
import type { GraphData } from "./types";
import { AGENT_COLOR } from "./types";
import { Section } from "./ui";

const COL: Record<string, number> = { Event: 0, Evidence: 0, Memory: 1, Knowledge: 1, Procedure: 1, Agent: 2, Decision: 2, Task: 2, Deal: 3 };
const KIND_COLOR: Record<string, string> = {
  Agent: "var(--color-ink)", Deal: "var(--color-accent)", Event: "var(--color-bad)", Memory: "var(--color-mem)",
  Knowledge: "var(--color-mem)", Procedure: "var(--color-warn)", Evidence: "var(--color-ok)", Decision: "var(--color-mayor)", Task: "var(--color-faint)",
};

/** Undirected shortest path (BFS) so we can show "original event → … → new decision". */
function shortestPath(g: GraphData, from: string, to: string): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  const prev = new Map<string, string | null>([[from, null]]);
  const q = [from];
  while (q.length) {
    const n = q.shift()!;
    if (n === to) { const p: string[] = []; for (let c: string | null = n; c; c = prev.get(c) ?? null) p.unshift(c); return p; }
    for (const m of adj.get(n) ?? []) if (!prev.has(m)) { prev.set(m, n); q.push(m); }
  }
  return null;
}

export function GraphView({ sim, refreshKey, focusUid, onFocusHandled }: { sim: string; refreshKey: number; focusUid: string | null; onFocusHandled: () => void }) {
  const [g, setG] = useState<GraphData>({ nodes: [], edges: [] });
  const [mode, setMode] = useState<"trace" | "all">("trace");
  const [err, setErr] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<GraphData>(`/api/graph?sim=${sim}`).then((d) => { if (live) { setG(d); setErr(null); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [sim, refreshKey]);

  useEffect(() => { if (focusUid) { setPin(focusUid); setMode("trace"); onFocusHandled(); } }, [focusUid, onFocusHandled]);

  const { nodes, edges, note } = useMemo(() => {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    // Anchor: pinned memory, else the newest Farmer decision. Target: the earliest broken-deal event.
    const decisions = g.nodes.filter((n) => n.kind === "Decision" && n.agent === "farmer").sort((a, b) => (b.round ?? 0) - (a.round ?? 0));
    const broken = g.nodes.filter((n) => n.kind === "Event" && n.label.startsWith("Broken")).sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    const anchor = pin ?? decisions[0]?.id ?? null;
    let path: string[] | null = null;
    if (anchor && broken[0]) path = shortestPath(g, anchor, broken[0].id);
    const onPath = new Set(path ?? []);
    const pathEdges = new Set<string>();
    if (path) for (let i = 0; i + 1 < path.length; i++) {
      const e = g.edges.find((x) => (x.source === path![i] && x.target === path![i + 1]) || (x.target === path![i] && x.source === path![i + 1]));
      if (e) pathEdges.add(e.id);
    }
    let keep = new Set(g.nodes.map((n) => n.id));
    if (mode === "trace" && path) {
      keep = new Set(onPath);
      for (const e of g.edges) { if (onPath.has(e.source)) keep.add(e.target); if (onPath.has(e.target)) keep.add(e.source); }
      // drop other agents' noise: keep Agents only if on path or directly attached
    }
    const cols = new Map<number, number>();
    const ns: Node[] = g.nodes.filter((n) => keep.has(n.id)).sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)).map((n) => {
      const c = COL[n.kind] ?? 2;
      const row = cols.get(c) ?? 0; cols.set(c, row + 1);
      const hot = onPath.has(n.id);
      const color = n.kind === "Agent" ? AGENT_COLOR[n.label.toLowerCase()] ?? KIND_COLOR.Agent : KIND_COLOR[n.kind];
      return {
        id: n.id, position: { x: c * 185, y: row * 52 + (c % 2) * 16 }, data: { label: n.label },
        draggable: false,
        style: {
          width: 160, fontSize: 10.5, padding: "5px 8px", borderRadius: 8, textAlign: "left" as const, lineHeight: 1.25,
          background: "var(--color-surface2)", color: "var(--color-ink)",
          borderStyle: "solid", borderWidth: "1px 1px 1px 3px", borderColor: `${hot ? color : "var(--color-line2)"} ${hot ? color : "var(--color-line2)"} ${hot ? color : "var(--color-line2)"} ${color}`, opacity: path && !hot ? 0.55 : 1,
          boxShadow: hot ? `0 0 0 1px color-mix(in srgb, ${color} 40%, transparent)` : "none",
        },
      };
    });
    const es: Edge[] = g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => {
      const hot = pathEdges.has(e.id);
      return {
        id: e.id, source: e.source, target: e.target, label: hot ? e.type.replaceAll("_", " ") : undefined,
        labelStyle: { fontSize: 9, fill: "var(--color-accent)" }, labelBgStyle: { fill: "var(--color-bg)" },
        animated: false,
        style: { stroke: hot ? "var(--color-accent)" : "var(--color-line2)", strokeWidth: hot ? 2 : 1, opacity: path && !hot ? 0.45 : 1 },
      };
    });
    const nm = path ? `${path.length - 1} hops from ${byId.get(path[0])?.label} to ${byId.get(path[path.length - 1])?.label}` : "no decision trace yet — run rounds 3–5";
    return { nodes: ns, edges: es, note: nm };
  }, [g, mode, pin]);

  return (
    <Section
      title="Graph inspector"
      className="h-[640px]"
      right={
        <div className="flex items-center gap-1">
          {pin && <button className="chip" onClick={() => setPin(null)}>unpin</button>}
          {(["trace", "all"] as const).map((m) => (
            <button key={m} className="chip" onClick={() => setMode(m)} style={mode === m ? { color: "var(--color-ink)", borderColor: "var(--color-accent)" } : undefined}>{m === "trace" ? "decision trace" : "full graph"}</button>
          ))}
        </div>
      }
    >
      <div className="border-b border-line px-3 py-1.5 text-[11px] text-sub">{err ?? note}</div>
      <div className="min-h-0 flex-1" aria-label="Graph visualization of events, memories, decisions and deals">
        {nodes.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-sub">The graph fills in as agents act. Run the first round.</div>
        ) : (
          <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.08, maxZoom: 1.1 }} minZoom={0.25} nodesConnectable={false} colorMode="dark" proOptions={{ hideAttribution: false }}>
            <Background gap={22} color="var(--color-line)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[10.5px] text-faint">
        {["Event", "Evidence", "Memory", "Knowledge", "Procedure", "Agent", "Decision", "Deal"].map((k) => (
          <span key={k} className="flex items-center gap-1"><i style={{ background: KIND_COLOR[k] }} className="inline-block h-2 w-2 rounded-sm" /> {k}</span>
        ))}
      </div>
    </Section>
  );
}
