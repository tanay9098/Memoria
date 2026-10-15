import { randomBytes } from "node:crypto";
import { seedSimulation, wipeSimulation } from "@/server/seed";
import { runNextRound, startNewSession } from "@/server/scenario";

export const newSim = (prefix = "t") => `${prefix}-${randomBytes(4).toString("hex")}`;

export async function seeded(prefix?: string) {
  const sim = newSim(prefix);
  await seedSimulation(sim);
  return sim;
}

/** Play rounds 1..n of the scripted scenario (starting a new session before round 5). */
export async function playTo(sim: string, n: number, memoryEnabled = true) {
  for (let r = 1; r <= n; r++) {
    if (r === 5) await startNewSession(sim);
    await runNextRound(sim, { memoryEnabled });
  }
}
export { wipeSimulation };
