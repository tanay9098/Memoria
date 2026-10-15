// Memory ON vs memory OFF on identical scripted scenarios. These are simulation results with a
// scripted adversarial Trader — they illustrate the mechanism, they do not prove general benefit.
import { q, ro, uid, closeAll } from "@/lib/falkor";
import { seedSimulation, wipeSimulation } from "./seed";
import { DEFAULT_SCENARIO, SCENARIOS, ScenarioConfig, runNextRound, startNewSession } from "./scenario";
import { getWorldState } from "./world";
import { checkIntegrity } from "./integrity";

export interface EvalRow {
  scenario: string; scenarioTitle: string; mode: "memory" | "no-memory";
  retrievedBrokenDeal: boolean; appliedProcedure: boolean; action: string; expectedAction: string;
  actionMatchesHistory: boolean; avoidedRepeatFailure: boolean; goalMet: boolean; balancesValid: boolean;
  farmerTools: number; villageWood: number; woodNeed: number; brokenDeals: number;
}
export interface EvalReport {
  ranAt: string; rows: EvalRow[];
  summary: Record<"memory" | "no-memory", { runs: number; retrieved: number; matched: number; avoided: number; goal: number; valid: number }>;
  disclaimer: string;
}

async function runOne(sc: ScenarioConfig, memoryEnabled: boolean): Promise<EvalRow> {
  const mode = memoryEnabled ? "memory" : "no-memory";
  const sim = `eval-${sc.id}-${mode}`;
  await seedSimulation(sim);
  for (let r = 1; r <= 4; r++) await runNextRound(sim, { memoryEnabled: true }, sc);
  await startNewSession(sim);
  await runNextRound(sim, { memoryEnabled }, sc);

  const decUid = uid(sim, "dec|r5:farmer:respond");
  const dec = (await ro(`MATCH (d:Decision {uid:$u}) RETURN d.action AS action`, { u: decUid }))[0];
  const used = await ro(
    `MATCH (d:Decision {uid:$u})-[u:USED]->(x) OPTIONAL MATCH (x)-[:ABOUT]->(deal:Deal {id:'D-2'})
     RETURN labels(x)[0] AS label, u.role AS role, x.outcome AS outcome, deal.id AS deal`, { u: decUid });
  const w = await getWorldState(sim);
  const integ = await checkIntegrity(sim);
  const broken = w.deals.filter((d) => d.state === "broken").length;
  const action = dec?.action ?? "none";
  const row: EvalRow = {
    scenario: sc.id, scenarioTitle: sc.title, mode,
    retrievedBrokenDeal: used.some((u) => u.label === "Memory" && u.deal === "D-2"),
    appliedProcedure: used.some((u) => u.label === "Procedure" && u.role === "applied"),
    action, expectedAction: sc.expected, actionMatchesHistory: action === sc.expected,
    avoidedRepeatFailure: broken === 1,
    goalMet: w.needs.farmerFoodGap === 0 && w.needs.villageWoodGap === 0,
    balancesValid: integ.ok,
    farmerTools: w.agents.find((a) => a.id === "farmer")!.resources.tools,
    villageWood: w.needs.villageWood, woodNeed: w.sim.villageWoodNeed, brokenDeals: broken,
  };
  await wipeSimulation(sim);
  return row;
}

export async function runEvaluation(scenarios: ScenarioConfig[] = SCENARIOS): Promise<EvalReport> {
  const rows: EvalRow[] = [];
  for (const sc of scenarios) {
    for (const m of [true, false]) rows.push(await runOne(sc, m));
  }
  const summary = { memory: blank(), "no-memory": blank() };
  for (const r of rows) {
    const s = summary[r.mode];
    s.runs++; s.retrieved += +r.retrievedBrokenDeal; s.matched += +r.actionMatchesHistory;
    s.avoided += +r.avoidedRepeatFailure; s.goal += +r.goalMet; s.valid += +r.balancesValid;
  }
  const report: EvalReport = {
    ranAt: new Date().toISOString(), rows, summary,
    disclaimer: "Results come from a small scripted simulation (3 scenarios) with a Trader scripted to default on unsecured prepaid deals ≥ 6 in value. They illustrate the effect of graph memory in this setup; they are not evidence that memory improves AI agents in general.",
  };
  await q(
    `MERGE (e:EvalRun {uid:'meta|eval|latest'}) SET e.sim='meta', e.ranAt=$ranAt, e.report=$report`,
    { ranAt: report.ranAt, report: JSON.stringify(report) },
  );
  return report;
}
const blank = () => ({ runs: 0, retrieved: 0, matched: 0, avoided: 0, goal: 0, valid: 0 });

export async function latestEvaluation(): Promise<EvalReport | null> {
  const r = await ro(`MATCH (e:EvalRun {uid:'meta|eval|latest'}) RETURN e.report AS report`);
  return r.length ? (JSON.parse(r[0].report) as EvalReport) : null;
}
export { DEFAULT_SCENARIO, closeAll };
