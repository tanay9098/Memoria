"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, Brain, ChevronRight, GitBranch, History, Lightbulb, ScrollText } from "lucide-react";
import { api } from "./api";
import type { MemoryItem, TraceData, WorldState } from "./types";
import { AGENT_COLOR } from "./types";
import { Avatar, Badge, Section } from "./ui";

const KIND_LABEL = { episodic: "Episodic · what happened", semantic: "Semantic · what I believe", procedural: "Procedural · what to do" } as const;
const EPI_TONE = { observed: "ok", inferred: "mem", suggested: "warn" } as const;
const EPI_HINT = { observed: "observed fact", inferred: "inference (belief)", suggested: "suggested strategy" } as const;

export function Inspector({
  sim, world, agentId, lastSeq, selectedUid, onSelect, onShowInGraph,
}: {
  sim: string; world: WorldState; agentId: string; lastSeq: number; selectedUid: string | null;
  onSelect: (uid: string | null) => void; onShowInGraph: (uid: string) => void;
}) {
  const [mems, setMems] = useState<MemoryItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ memories: MemoryItem[] }>(`/api/memories?sim=${sim}&agent=${agentId}`)
      .then((r) => { if (live) { setMems(r.memories); setErr(null); } })
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [sim, agentId, lastSeq]);

  const agent = world.agents.find((a) => a.id === agentId)!;
  const selected = selectedUid ? mems.find((m) => m.uid === selectedUid) : null;
  const myDeals = world.deals.filter((d) => (d.proposer === agentId || d.counterparty === agentId) && ["proposed", "accepted"].includes(d.state));
  const myTasks = world.tasks.filter((t) => (t.from === agentId || t.to === agentId) && t.state !== "done");

  // Memories that fed this agent's most recent decision
  const latestDec = mems.flatMap((m) => m.influenced).filter((d) => d.agent === agentId).sort((a, b) => b.sessionNo - a.sessionNo || b.round - a.round)[0];
  const usedInLatest = latestDec ? mems.filter((m) => m.influenced.some((d) => d.decisionUid === latestDec.decisionUid)) : [];

  return (
    <Section title={selected ? "Memory inspector" : "Agent inspector"} className="h-[640px]">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {err && <p className="mb-2 text-bad">{err}</p>}
        {selected ? (
          <MemoryDetail sim={sim} m={selected} onBack={() => onSelect(null)} onShowInGraph={onShowInGraph} />
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              <Avatar id={agent.id} size={34} />
              <div>
                <div className="font-medium">{agent.name} <span className="text-faint">· {agent.role}</span></div>
                <div className="text-[11.5px] text-sub">{agent.goal}</div>
              </div>
            </div>
            <div className="mt-2 rounded-md border border-line bg-surface2 px-2.5 py-1.5 text-[11.5px]"><span className="text-faint">Latest action · r{agent.lastActionRound}: </span>{agent.lastAction}</div>

            {(myDeals.length > 0 || myTasks.length > 0) && (
              <div className="mt-3">
                <div className="eyebrow mb-1">Active proposals & handoffs</div>
                <ul className="space-y-1">
                  {myDeals.map((d) => (
                    <li key={d.id} className="rounded-md border border-line px-2 py-1 text-[11.5px]">
                      <b>{d.id}</b> <Badge tone={d.state === "accepted" ? "ok" : "warn"}>{d.state}</Badge>{" "}
                      {d.proposer} gives {d.giveQty} {d.giveRes} ⇄ {d.counterparty} gives {d.getQty} {d.getRes}
                      {d.leader ? <> · <span className="text-accent">{d.leader} delivers first</span></> : <> · <span className="text-warn">unsecured</span></>}
                    </li>
                  ))}
                  {myTasks.map((t) => (
                    <li key={t.id} className="rounded-md border border-line px-2 py-1 text-[11.5px]"><b>{t.id}</b> {t.kind.replace("_", " ")} · {t.from} → {t.to}</li>
                  ))}
                </ul>
              </div>
            )}

            {usedInLatest.length > 0 && latestDec && (
              <div className="mt-3 rounded-md border border-mem/30 bg-mem/5 p-2">
                <div className="eyebrow mb-1 flex items-center gap-1" style={{ color: "var(--color-mem)" }}><Lightbulb size={11} /> Retrieved for the latest decision (r{latestDec.round}, session {latestDec.sessionNo}: {latestDec.action.replaceAll("_", " ")})</div>
                <ul className="space-y-1">
                  {usedInLatest.map((m) => (
                    <li key={m.uid}><button className="text-left text-[11.5px] hover:underline" onClick={() => onSelect(m.uid)}>• {m.title}</button></li>
                  ))}
                </ul>
              </div>
            )}

            {(["episodic", "semantic", "procedural"] as const).map((k) => {
              const items = mems.filter((m) => m.kind === k);
              return (
                <div key={k} className="mt-3">
                  <div className="eyebrow mb-1">{KIND_LABEL[k]} · {items.length}</div>
                  {items.length === 0 && <div className="text-[11.5px] text-faint">none yet</div>}
                  <ul className="space-y-1.5">
                    {items.map((m) => (
                      <li key={m.uid}>
                        <button onClick={() => onSelect(m.uid)} className="group w-full rounded-md border border-line bg-surface2/60 p-2 text-left transition-colors hover:border-line2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[12px] font-medium">{m.title}</span>
                            <ChevronRight size={12} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            <Badge tone={EPI_TONE[m.epistemic]} title={EPI_HINT[m.epistemic]}>{EPI_HINT[m.epistemic]}</Badge>
                            <Badge>{m.status}</Badge>
                            {m.value !== null && <Badge tone={m.value < 0.6 ? "bad" : "ok"}>{m.value.toFixed(2)}</Badge>}
                            {m.influenced.length > 0 && <Badge tone="accent">used in {m.influenced.length} decision{m.influenced.length > 1 ? "s" : ""}</Badge>}
                          </div>
                          {m.kind === "semantic" && m.revisions.length > 0 && (
                            <div className="mt-1 text-[11px] tabular-nums text-sub">{m.revisions.map((r) => r.to.toFixed(2)).join(" → ")}</div>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </>
        )}
      </div>
    </Section>
  );
}

function MemoryDetail({ sim, m, onBack, onShowInGraph }: { sim: string; m: MemoryItem; onBack: () => void; onShowInGraph: (u: string) => void }) {
  const [trace, setTrace] = useState<TraceData | null>(null);
  useEffect(() => {
    let live = true;
    api<TraceData>(`/api/trace?sim=${sim}&uid=${encodeURIComponent(m.uid)}`).then((t) => live && setTrace(t)).catch(() => undefined);
    return () => { live = false; };
  }, [sim, m.uid, m.influenced.length]);

  return (
    <div className="enter">
      <button className="btn mb-2" onClick={onBack}><ArrowLeft size={12} /> Back to {m.owner}</button>
      <div className="flex items-center gap-1.5">
        <Badge tone="mem"><Brain size={10} /> {m.kind}</Badge>
        <Badge tone={EPI_TONE[m.epistemic]}>{EPI_HINT[m.epistemic]}</Badge>
        <Badge>{m.status}</Badge>
        {m.confidence !== null && <Badge title="evidence strength">confidence {m.confidence.toFixed(2)}</Badge>}
      </div>
      <h3 className="mt-2 text-[14px] font-medium">{m.title}</h3>
      <p className="mt-1 text-[12.5px] leading-relaxed">{m.content}</p>
      {m.value !== null && <div className="mt-2 text-[12px]">Current value <b className={m.value < 0.6 ? "text-bad" : "text-ok"}>{m.value.toFixed(2)}</b> <span className="text-faint">(threshold 0.60)</span></div>}
      {m.stats && <div className="mt-2 text-[12px]">Outcome record: <b>{m.stats.successCount}</b> success · <b>{m.stats.failureCount}</b> failure {m.status === "proposed" && <span className="text-warn">— unvalidated until a decision using it is evaluated</span>}</div>}

      <Block icon={<ScrollText size={12} />} title="Provenance">
        <dl className="grid grid-cols-[84px_1fr] gap-x-2 gap-y-1 text-[11.5px]">
          <dt className="text-faint">Owner</dt><dd>{m.owner}</dd>
          <dt className="text-faint">Written</dt><dd>round {m.round} · {new Date(m.ts).toLocaleTimeString()}</dd>
          <dt className="text-faint">About</dt><dd>{[...m.subjects, m.dealId].filter(Boolean).join(", ") || "—"}</dd>
          <dt className="text-faint">Source event</dt><dd className="font-mono text-[10.5px] break-all">{m.eventUid ?? trace?.events[0]?.uid ?? "—"}</dd>
        </dl>
        {m.evidence.length > 0 && (
          <ul className="mt-2 space-y-1">
            {m.evidence.map((e) => (
              <li key={e.uid} className="rounded border border-line px-2 py-1 text-[11.5px]"><span className="text-ok">Evidence:</span> {e.summary}</li>
            ))}
          </ul>
        )}
        {trace && trace.events.length > 0 && (
          <ul className="mt-2 space-y-1">
            {trace.events.map((e) => <li key={e.uid} className="text-[11.5px] text-sub">↳ event #{e.seq} · r{e.round}: {e.summary}</li>)}
          </ul>
        )}
      </Block>

      {m.revisions.length > 0 && (
        <Block icon={<History size={12} />} title="Update history">
          <ul className="space-y-1">
            {m.revisions.map((r, i) => (
              <li key={i} className="flex items-center gap-2 text-[11.5px] tabular-nums">
                <span className="text-faint">r{r.round}</span><span>{r.from.toFixed(2)} → <b className={r.to < r.from ? "text-bad" : "text-ok"}>{r.to.toFixed(2)}</b></span><span className="text-sub">{r.reason}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block icon={<GitBranch size={12} />} title="How it influenced decisions">
        {(trace?.decisions.length ?? 0) === 0 && <div className="text-[11.5px] text-faint">No decision has used this memory yet.</div>}
        <ul className="space-y-1.5">
          {trace?.decisions.map((d) => (
            <li key={d.uid} className="rounded-md border border-line p-2 text-[11.5px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <b style={{ color: AGENT_COLOR[d.agent] }}>{d.agent}</b>
                <span>→ {d.action.replaceAll("_", " ")}</span>
                <Badge tone={d.role === "applied" ? "accent" : "neutral"}>{d.role}</Badge>
                <span className="text-faint">session {d.session} · r{d.round}</span>
                {!d.memoryEnabled && <Badge tone="warn">memory off</Badge>}
              </div>
              <p className="mt-1 text-sub">{d.rationale}</p>
              {d.produced && <div className="mt-1 text-faint">produced {d.produced}{d.responds ? ` in response to ${d.responds}` : ""}</div>}
            </li>
          ))}
        </ul>
      </Block>
      <button className="btn btn-primary mt-3" onClick={() => onShowInGraph(m.uid)}><GitBranch size={12} /> Trace in graph</button>
    </div>
  );
}

function Block({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="eyebrow mb-1.5 flex items-center gap-1">{icon} {title}</div>
      {children}
    </div>
  );
}
