import { runConcurrencyTests } from "../src/server/concurrency";
import { closeAll } from "../src/lib/falkor";

const r = await runConcurrencyTests();
for (const c of r.cases) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`);
console.log(`INFO  ${r.control.name}\n      ${r.control.detail}`);
for (const c of r.integrity.checks) console.log(`${c.ok ? "PASS" : "FAIL"}  integrity: ${c.name} — ${c.detail}`);
console.log(r.ok ? "\nAll concurrency checks passed." : "\nFAILED");
await closeAll();
process.exit(r.ok ? 0 : 1);
