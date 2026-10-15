"use client";
import { Apple, Axe, Handshake, Wrench, Loader2 } from "lucide-react";
import type { AgentView, WorldState } from "./types";
import { AGENT_COLOR } from "./types";
import { AnimatedNumber, Avatar, Badge } from "./ui";

const ICON = { food: Apple, wood: Axe, tools: Wrench } as const;

export function ResourceCards({ world }: { world: WorldState }) {
  const farmer = world.agents.find((a) => a.id === "farmer");
  const cards = [
    { key: "food" as const, label: "Food", total: world.totals.food, note: farmer ? `Farmer ${farmer.resources.food} / ${world.sim.farmerFoodNeed} needed` : "", short: world.needs.farmerFoodGap },
    { key: "wood" as const, label: "Wood", total: world.totals.wood, note: `Village stock ${world.needs.villageWood} / ${world.sim.villageWoodNeed} needed`, short: world.needs.villageWoodGap },
    { key: "tools" as const, label: "Tools", total: world.totals.tools, note: "Used as currency", short: 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => {
        const Icon = ICON[c.key];
        return (
          <div key={c.key} className="card p-3" aria-label={`${c.label} total ${c.total}`}>
            <div className="flex items-center justify-between">
              <span className="eyebrow flex items-center gap-1.5"><Icon size={13} /> {c.label}</span>
              {c.short > 0 ? <Badge tone="warn">short {c.short}</Badge> : c.key !== "tools" ? <Badge tone="ok">covered</Badge> : null}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <AnimatedNumber value={c.total} className="text-2xl font-semibold tabular-nums" />
              <span className="text-[11px] text-faint">total in village</span>
            </div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line" title="Holdings by agent">
              {world.agents.map((a) => (
                <div key={a.id} style={{ width: `${c.total ? (a.resources[c.key] / c.total) * 100 : 0}%`, background: AGENT_COLOR[a.id], transition: "width .35s ease" }} />
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-sub">{c.note}</div>
          </div>
        );
      })}
      <div className="card p-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow flex items-center gap-1.5"><Handshake size={13} /> Open deals</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <AnimatedNumber value={world.openDeals} className="text-2xl font-semibold tabular-nums" />
          <span className="text-[11px] text-faint">of {world.deals.length} total</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {(["fulfilled", "broken", "countered", "rejected"] as const).map((s) => {
            const n = world.deals.filter((d) => d.state === s).length;
            return n ? <Badge key={s} tone={s === "fulfilled" ? "ok" : s === "broken" ? "bad" : "neutral"}>{n} {s}</Badge> : null;
          })}
        </div>
      </div>
    </div>
  );
}

export function AgentCards({ agents, selected, onSelect, busy }: { agents: AgentView[]; selected: string; onSelect: (id: string) => void; busy: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {agents.map((a) => {
        const active = a.status !== "idle";
        return (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            aria-pressed={selected === a.id}
            className="card p-3 text-left transition-colors hover:border-line2"
            style={selected === a.id ? { borderColor: `color-mix(in srgb, ${AGENT_COLOR[a.id]} 55%, var(--color-line))` } : undefined}
          >
            <div className="flex items-center gap-2.5">
              <Avatar id={a.id} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-[11px] text-faint">{a.role}</span>
                </div>
              </div>
              <span className="chip" style={{ color: active ? "var(--color-accent)" : "var(--color-faint)" }}>
                {active ? <Loader2 size={11} className="animate-spin" /> : <span className="h-1.5 w-1.5 rounded-full bg-faint" />}
                {a.status === "thinking" ? "retrieving & deciding…" : a.status === "acting" ? "acting…" : "idle"}
              </span>
            </div>
            <p className="mt-2 line-clamp-2 text-[11.5px] text-sub">{a.goal}</p>
            <div key={a.lastAction} className="enter mt-2 truncate border-t border-line pt-2 text-[11.5px]" title={a.lastAction}>
              <span className="text-faint">r{a.lastActionRound} · </span>{a.lastAction}
            </div>
            <div className="mt-1.5 flex gap-3 text-[11px] tabular-nums text-sub">
              <span>🍞 {a.resources.food}</span><span>🪵 {a.resources.wood}</span><span>🔧 {a.resources.tools}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
