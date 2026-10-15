"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, Brain, Share2, Sparkles, ShieldAlert } from "lucide-react";
import type { EventView } from "./types";
import { Badge, Section } from "./ui";

const FILTERS = [
  { id: "all", label: "All" }, { id: "state", label: "State changes" }, { id: "memory", label: "Memory" },
  { id: "coordination", label: "Coordination" }, { id: "suggestion", label: "Suggestions" },
] as const;

function meta(e: EventView) {
  if (e.type === "ACTION_REJECTED") return { Icon: ShieldAlert, tone: "var(--color-bad)", tag: "REJECTED by backend — nothing changed" };
  switch (e.category) {
    case "state": return { Icon: ArrowLeftRight, tone: e.type === "DEAL_BROKEN" ? "var(--color-bad)" : e.type === "DEAL_FULFILLED" ? "var(--color-ok)" : "var(--color-accent)", tag: e.outcome === "scripted" ? "SCRIPTED EVENT · persisted" : "CONFIRMED · persisted" };
    case "memory": return { Icon: Brain, tone: "var(--color-mem)", tag: e.outcome === "disabled" ? "MEMORY OFF" : "MEMORY" };
    case "coordination": return { Icon: Share2, tone: "var(--color-mayor)", tag: "COORDINATION" };
    default: return { Icon: Sparkles, tone: "var(--color-warn)", tag: e.type === "LLM_FALLBACK" ? "LLM UNAVAILABLE · fallback used" : "LLM SUGGESTION · validated before applying" };
  }
}

export function ActivityFeed({ events, onOpenMemory }: { events: EventView[]; onOpenMemory?: (uid: string) => void }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const seen = useRef<number>(-1);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(() => {
    const max = events.reduce((m, e) => Math.max(m, e.seq), -1);
    if (seen.current >= 0 && max > seen.current) {
      setFresh(new Set(events.filter((e) => e.seq > seen.current).map((e) => e.seq)));
      const t = setTimeout(() => setFresh(new Set()), 500);
      seen.current = max;
      return () => clearTimeout(t);
    }
    seen.current = max;
  }, [events]);

  const shown = events.filter((e) => filter === "all" || e.category === filter);
  return (
    <Section
      title="Activity feed"
      className="h-[640px]"
      right={<span className="text-[11px] text-faint">{shown.length} events · from FalkorDB</span>}
    >
      <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
            className="chip transition-colors" style={filter === f.id ? { color: "var(--color-ink)", borderColor: "var(--color-accent)" } : undefined}>
            {f.label}
          </button>
        ))}
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <li className="p-4 text-sub">No events yet. Press “Run next round”.</li>}
        {shown.map((e) => {
          const { Icon, tone, tag } = meta(e);
          const mem = (e.data as any)?.items as { uid: string; title: string; kind: string }[] | undefined;
          return (
            <li key={e.uid} className={`border-b border-line px-3 py-2 ${fresh.has(e.seq) ? "enter flash" : ""}`}>
              <div className="flex items-start gap-2">
                <span className="mt-0.5" style={{ color: tone }}><Icon size={14} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 text-[10.5px]">
                    <span className="font-medium tracking-wide" style={{ color: tone }}>{tag}</span>
                    <span className="text-faint">{e.type.replaceAll("_", " ").toLowerCase()} · r{e.round} · s{e.session} · #{e.seq}</span>
                  </div>
                  <p className="mt-0.5 break-words text-[12px]" style={e.category === "suggestion" ? { fontStyle: "italic", color: "var(--color-sub)" } : undefined}>{e.summary}</p>
                  {mem && mem.length > 0 && onOpenMemory && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {mem.slice(0, 5).map((m) => (
                        <button key={m.uid} onClick={() => onOpenMemory(m.uid)} className="chip hover:border-mem" title="Open in memory inspector">
                          <Brain size={10} /> {m.title.length > 34 ? m.title.slice(0, 33) + "…" : m.title}
                        </button>
                      ))}
                    </div>
                  )}
                  {e.type === "DECISION" && <Badge tone={(e.data as any).memoryEnabled ? "mem" : "warn"}>{(e.data as any).memoryEnabled ? "memory on" : "memory off"}</Badge>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
