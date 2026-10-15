"use client";
import { useEffect, useState } from "react";
import { Check, FlaskConical, Loader2, ShieldCheck, X } from "lucide-react";
import { api } from "./api";
import type { ConcurrencyReport, EvalReport, IntegrityReport } from "./types";
import { Badge, Section } from "./ui";

const Tick = ({ ok }: { ok: boolean }) => (ok ? <Check size={13} className="text-ok" aria-label="yes" /> : <X size={13} className="text-bad" aria-label="no" />);

export function EvalPanel() {
  const [report, setReport] = useState<EvalReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ report: EvalReport | null }>("/api/eval").then((r) => setReport(r.report)).catch(() => undefined); }, []);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setReport((await api<{ report: EvalReport }>("/api/eval", { method: "POST" })).report); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const cols = ["Retrieved D-2", "Procedure applied", "Action matched history", "No repeat failure", "Goal met", "Balances valid"];
  return (
    <Section
      title="Evaluation · memory enabled vs unavailable"
      right={<button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />} {report ? "Re-run" : "Run"} comparison</button>}
    >
      <div className="overflow-x-auto p-3">
        {err && <p className="mb-2 text-bad">{err}</p>}
        {!report ? (
          <p className="text-sub">Runs the same scripted scenarios in isolated simulations twice — once with graph memory retrieval, once without — and compares outcomes. Takes a few seconds.</p>
        ) : (
          <>
            <table className="w-full min-w-[640px] text-left text-[11.5px]">
              <thead className="text-faint">
                <tr><th className="py-1 pr-2 font-normal">Scenario</th><th className="pr-2 font-normal">Mode</th>{cols.map((c) => <th key={c} className="px-1 text-center font-normal">{c}</th>)}<th className="pl-2 font-normal">Action · wood</th></tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.scenario + r.mode} className="border-t border-line">
                    <td className="py-1.5 pr-2">{r.scenarioTitle}</td>
                    <td className="pr-2"><Badge tone={r.mode === "memory" ? "mem" : "warn"}>{r.mode === "memory" ? "memory on" : "memory off"}</Badge></td>
                    {[r.retrievedBrokenDeal, r.appliedProcedure, r.actionMatchesHistory, r.avoidedRepeatFailure, r.goalMet, r.balancesValid].map((v, i) => <td key={i} className="text-center"><Tick ok={v} /></td>)}
                    <td className="pl-2 tabular-nums">{r.action.replace("_", " ")} · {r.villageWood}/{r.woodNeed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {(["memory", "no-memory"] as const).map((m) => (
                <div key={m} className="rounded-md border border-line p-2">
                  <div className="eyebrow">{m === "memory" ? "Memory on" : "Memory off"}</div>
                  <div className="mt-1 text-[12px] tabular-nums">Goal met <b>{report.summary[m].goal}/{report.summary[m].runs}</b> · repeat failure avoided <b>{report.summary[m].avoided}/{report.summary[m].runs}</b></div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-faint">{report.disclaimer}</p>
          </>
        )}
      </div>
    </Section>
  );
}

export function IntegrityPanel({ sim, refreshKey }: { sim: string; refreshKey: number }) {
  const [integ, setInteg] = useState<IntegrityReport | null>(null);
  const [conc, setConc] = useState<ConcurrencyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<IntegrityReport>(`/api/integrity?sim=${sim}`).then(setInteg).catch(() => undefined); }, [sim, refreshKey]);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setConc(await api<ConcurrencyReport>("/api/concurrency", { method: "POST" })); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Section
      title="Integrity & concurrency"
      right={<button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Run competing-transaction test</button>}
    >
      <div className="space-y-3 p-3">
        {err && <p className="text-bad">{err}</p>}
        <div>
          <div className="eyebrow mb-1">Live village audit</div>
          <ul className="space-y-1">
            {integ?.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-[11.5px]"><Tick ok={c.ok} /><span><b className="font-medium">{c.name}</b> <span className="text-sub">— {c.detail}</span></span></li>
            )) ?? <li className="text-sub">Loading…</li>}
          </ul>
        </div>
        {conc && (
          <div className="enter border-t border-line pt-2">
            <div className="eyebrow mb-1">Competing transactions · {new Date(conc.ranAt).toLocaleTimeString()}</div>
            <ul className="space-y-1">
              {conc.cases.map((c) => <li key={c.name} className="flex items-start gap-2 text-[11.5px]"><Tick ok={c.ok} /><span><b className="font-medium">{c.name}</b><br /><span className="text-sub">{c.detail}</span></span></li>)}
              <li className="flex items-start gap-2 text-[11.5px]"><Tick ok={conc.control.ok} /><span><b className="font-medium">{conc.control.name}</b><br /><span className="text-sub">{conc.control.detail}</span></span></li>
            </ul>
            <p className="mt-2 text-[11px] text-faint">Each guarded write is a single atomic FalkorDB statement (balance check + transfer + idempotency marker). There are no multi-statement transactions; multi-step flows rely on keyed, idempotent steps. The control row shows the harness does detect a race when the guard is split across two statements.</p>
          </div>
        )}
      </div>
    </Section>
  );
}
