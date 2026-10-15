import { runEvaluation } from "../src/server/evaluation";
import { closeAll } from "../src/lib/falkor";

const report = await runEvaluation();
console.table(report.rows.map((r) => ({
  scenario: r.scenario, mode: r.mode, "retrieved D-2": r.retrievedBrokenDeal, procedure: r.appliedProcedure,
  action: r.action, expected: r.expectedAction, "matches history": r.actionMatchesHistory,
  "no repeat failure": r.avoidedRepeatFailure, "goal met": r.goalMet, "balances valid": r.balancesValid,
  wood: `${r.villageWood}/${r.woodNeed}`,
})));
console.log(JSON.stringify(report.summary, null, 2));
console.log(report.disclaimer);
await closeAll();
