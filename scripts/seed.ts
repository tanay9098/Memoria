import { seedSimulation } from "../src/server/seed";
import { getWorldState } from "../src/server/world";
import { config } from "../src/lib/config";
import { closeAll } from "../src/lib/falkor";

const sim = process.argv[2] ?? config.defaultSim;
await seedSimulation(sim);
const w = await getWorldState(sim);
console.log(`Seeded '${sim}' in graph '${config.falkor.graph}'.`);
console.table(w.agents.map((a) => ({ agent: a.id, ...a.resources })));
await closeAll();
