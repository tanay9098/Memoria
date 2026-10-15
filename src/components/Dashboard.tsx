"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, CircleAlert, Database, Pause, Play, RotateCcw, SkipForward, Sparkles, UserPlus } from "lucide-react";
import { ApiError, api } from "./api";
import type { Health, StateResponse } from "./types";
import { AgentCards, ResourceCards } from "./Cards";
import { ActivityFeed } from "./ActivityFeed";
import { Inspector } from "./Inspector";
import { GraphView } from "./GraphView";
import { EvalPanel, IntegrityPanel } from "./Panels";
import { Badge } from "./ui";

const SIM = "village-1";

export default function Dashboard() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [busy, setBusy] = useState<null | "round" | "reset" | "session">(null);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [llm, setLlm] = useState(false);
  const [auto, setAuto] = useState(false);
  const [agent, setAgent] = useState("farmer");
  const [memUid, setMemUid] = useState<string | null>(null);
  const [graphFocus, setGraphFocus] = useState<string | null>(null);
  const autoRef = useRef(false);
  const busyRef = useRef<typeof busy>(null);
  busyRef.current = busy;

  // UI preferences only (harmless): remembered in the browser. All world state lives in FalkorDB.
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem("memoria-prefs") ?? "{}");
      if (typeof p.memoryEnabled === "boolean") setMemoryEnabled(p.memoryEnabled);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem("memoria-prefs", JSON.stringify({ memoryEnabled })); } catch { /* ignore */ } }, [memoryEnabled]);

  const refresh = useCallback(async () => {
    try {
      setData(await api<StateResponse>(`/api/state?sim=${SIM}`));
      setError(null);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === "not_found") {
        // First run: create the village in FalkorDB.
        try { await api("/api/reset", { method: "POST", json: { sim: SIM } }); setData(await api<StateResponse>(`/api/state?sim=${SIM}`)); setError(null); return; } catch (e2) { setError({ message: (e2 as Error).message, code: (e2 as ApiError).code }); return; }
      }
      setError({ message: ae.message, code: ae.code });
    }
  }, []);

  useEffect(() => { api<Health>(`/api/health?sim=${SIM}`).then(setHealth).catch(() => undefined); refresh(); }, [refresh]);
  // Poll: quickly while an agent round is running (live progress), slowly otherwise.
  useEffect(() => {
    const t = setInterval(refresh, busy === "round" ? 400 : 4000);
    return () => clearInterval(t);
  }, [busy, refresh]);

  const world = data?.world;
  const round = world?.sim.round ?? 0;
  const session = world?.sim.session ?? 1;
  const maxRound = world?.sim.maxRound ?? 5;
  const nextNeedsSession = round === 4 && session < 2;
  const finished = round >= maxRound;

  const runRound = useCallback(async () => {
    setBusy("round");
    try {
      await api("/api/round", { method: "POST", json: { sim: SIM, memoryEnabled, llm } });
      await refresh();
      setError(null);
      return true;
    } catch (e) {
      setError({ message: (e as Error).message, code: (e as ApiError).code });
      await refresh();
      return false;
    } finally { setBusy(null); }
  }, [memoryEnabled, llm, refresh]);

  const stopAuto = () => { autoRef.current = false; setAuto(false); };
  const startAuto = async () => {
    autoRef.current = true; setAuto(true);
    while (autoRef.current) {
      const st = await api<StateResponse>(`/api/state?sim=${SIM}`).catch(() => null);
      if (!st || st.world.sim.round >= st.world.sim.maxRound || (st.world.sim.round === 4 && st.world.sim.session < 2)) break;
      if (!(await runRound())) break;
      await new Promise((r) => setTimeout(r, 900));
    }
    stopAuto();
  };

  const reset = async () => {
    stopAuto(); setBusy("reset");
    try { await api("/api/reset", { method: "POST", json: { sim: SIM } }); setMemUid(null); await refresh(); setError(null); }
    catch (e) { setError({ message: (e as Error).message, code: (e as ApiError).code }); }
    finally { setBusy(null); }
  };
  const newSession = async () => {
    setBusy("session");
    try { await api("/api/session", { method: "POST", json: { sim: SIM } }); setMemUid(null); await refresh(); setError(null); }
    catch (e) { setError({ message: (e as Error).message, code: (e as ApiError).code }); }
    finally { setBusy(null); }
  };

  const lastSeq = data?.events[0]?.seq ?? 0;
  const openMemory = useCallback((uid: string) => {
    // Memory items belong to an agent; find the owner from the uid ("sim|mem|owner|…" or "sim|belief|owner|…")
    const parts = uid.split("|");
    const owner = parts[1] === "mem" || parts[1] === "belief" ? parts[2] : parts[1] === "proc" ? parts[3] : null;
    if (owner && ["farmer", "trader", "mayor"].includes(owner)) setAgent(owner);
    setMemUid(uid);
  }, []);

  if (error && !data) {
    return (
      <main className="mx-auto grid min-h-screen max-w-xl place-items-center p-6">
        <div className="card p-5">
          <div className="flex items-center gap-2 text-bad"><CircleAlert size={16} /> {error.code === "graph_unavailable" ? "FalkorDB is not reachable" : "Something went wrong"}</div>
          <p className="mt-2 break-words text-sub">{error.message}</p>
          <pre className="mt-3 rounded-md border border-line bg-bg p-2 font-mono text-[11.5px]">docker compose up -d{"\n"}npm run seed</pre>
          <button className="btn mt-3" onClick={refresh}>Retry</button>
        </div>
      </main>
    );
  }
  if (!world || !data) return <main className="grid min-h-screen place-items-center text-sub"><span className="pulse">Loading village from FalkorDB…</span></main>;

  const nextTitle = !finished ? data.rounds[round + 1] : null;

  return (
    <main className="mx-auto max-w-[1600px] px-4 pb-10 pt-4 sm:px-6">
      {busy === "round" && <div className="progress fixed inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-line" role="progressbar" aria-label="Agents are working" />}

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg border border-line2 bg-surface2 text-accent"><Brain size={16} /></div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight">Memoria <span className="font-normal text-faint">/ {world.sim.name}</span></h1>
            <p className="text-[11.5px] text-sub">A living world where AI agents remember, negotiate, and learn together.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="accent">Round {round} / {maxRound}</Badge>
          <Badge>Session {session}</Badge>
          <Badge tone={health?.falkordb.ok ? "ok" : "bad"} title={health?.falkordb.error}><Database size={10} /> FalkorDB {health ? (health.falkordb.ok ? `· graph “${health.falkordb.graph}”` : "down") : "…"}</Badge>
          <Badge tone={health?.llm.configured ? "accent" : "neutral"} title="Without an API key agents use the deterministic policy engine">
            <Sparkles size={10} /> {health?.llm.configured ? `LLM: ${health.llm.model}` : "LLM off · deterministic policy"}
          </Badge>
        </div>
      </header>

      {error && (
        <div role="alert" className="enter mt-3 flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-[12px]">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-bad" />
          <div className="flex-1"><b className="font-medium">{error.code === "rejected" ? "Backend refused:" : "Error:"}</b> {error.message}</div>
          <button className="text-faint hover:text-ink" onClick={() => setError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Controls */}
      <div className="card mt-3 flex flex-wrap items-center gap-2 p-2.5">
        {auto ? (
          <button className="btn" onClick={stopAuto}><Pause size={13} /> Pause</button>
        ) : (
          <button className="btn" onClick={startAuto} disabled={!!busy || finished || nextNeedsSession} title="Play rounds until the next manual step"><Play size={13} /> Auto-play</button>
        )}
        <button className="btn btn-primary" onClick={runRound} disabled={!!busy || finished || nextNeedsSession || auto}>
          <SkipForward size={13} /> {busy === "round" ? "Agents working…" : finished ? "Scenario complete" : nextNeedsSession ? "Start a new session to continue" : `Run next round${nextTitle ? `: ${nextTitle}` : ""}`}
        </button>
        <button className={`btn ${nextNeedsSession ? "btn-primary" : ""}`} onClick={newSession} disabled={!!busy} title="Starts a new interaction session. The village and all graph memory stay in FalkorDB; only the chat/session context resets.">
          <UserPlus size={13} /> New session
        </button>
        <button className="btn" onClick={reset} disabled={busy === "reset"}><RotateCcw size={13} /> Reset demo</button>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[12px]">
          <label className="flex cursor-pointer items-center gap-2" title="Round 5 decisions: retrieve graph memory (on) or decide from current world state only (off).">
            <input type="checkbox" className="accent-[var(--color-accent)]" checked={memoryEnabled} onChange={(e) => setMemoryEnabled(e.target.checked)} />
            <span>Memory retrieval <span className="text-faint">(round 5)</span></span>
            <Badge tone={memoryEnabled ? "mem" : "warn"}>{memoryEnabled ? "mode A" : "mode B"}</Badge>
          </label>
          <label className={`flex items-center gap-2 ${health?.llm.configured ? "cursor-pointer" : "opacity-50"}`} title={health?.llm.configured ? "Let the LLM choose among the legal options; the backend still validates" : "Set ANTHROPIC_API_KEY on the server to enable"}>
            <input type="checkbox" className="accent-[var(--color-accent)]" disabled={!health?.llm.configured} checked={llm} onChange={(e) => setLlm(e.target.checked)} />
            LLM assist
          </label>
        </div>
      </div>

      {/* Scenario stepper */}
      <ol className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5" aria-label="Scenario progress">
        {Object.entries(data.rounds).map(([n, title]) => {
          const i = Number(n), done = i <= round, cur = i === round + 1;
          return (
            <li key={n} className="rounded-lg border px-2.5 py-1.5 text-[11.5px] transition-colors" style={{ borderColor: cur ? "var(--color-accent)" : "var(--color-line)", background: done ? "color-mix(in srgb, var(--color-ok) 6%, transparent)" : "transparent", color: done || cur ? "var(--color-ink)" : "var(--color-faint)" }}>
              <span className="text-faint">{i}</span> {title}{i === 5 && <span className="text-faint"> · needs new session</span>}
            </li>
          );
        })}
      </ol>

      <div className="mt-3 space-y-3">
        <ResourceCards world={world} />
        <AgentCards agents={world.agents} selected={agent} onSelect={(a) => { setAgent(a); setMemUid(null); }} busy={busy === "round"} />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-12">
        <div className="xl:col-span-3"><ActivityFeed events={data.events} onOpenMemory={openMemory} /></div>
        <div className="xl:col-span-4"><Inspector sim={SIM} world={world} agentId={agent} lastSeq={lastSeq} selectedUid={memUid} onSelect={setMemUid} onShowInGraph={setGraphFocus} /></div>
        <div className="xl:col-span-5"><GraphView sim={SIM} refreshKey={lastSeq} focusUid={graphFocus} onFocusHandled={() => setGraphFocus(null)} /></div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-5">
        <div className="xl:col-span-3"><EvalPanel /></div>
        <div className="xl:col-span-2"><IntegrityPanel sim={SIM} refreshKey={lastSeq} /></div>
      </div>

      <footer className="mt-6 text-center text-[11px] text-faint">
        All world state and memory are read from FalkorDB on every refresh. Browser storage holds only the memory-toggle preference.
      </footer>
    </main>
  );
}
