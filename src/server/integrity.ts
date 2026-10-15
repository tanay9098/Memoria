import { ro } from "@/lib/falkor";
import { RESOURCES } from "@/lib/domain";
import { P } from "./events";
import { getWorldState } from "./world";

export interface IntegrityReport { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }

/**
 * Independent audit of the persisted world:
 *  - no negative balances
 *  - resource totals are conserved (transfers only move things around)
 *  - every deal's delivered amounts are within its terms and consistent with its state
 *  - the event log reconciles with the balances (initial + received − sent == current)
 */
export async function checkIntegrity(sim: string): Promise<IntegrityReport> {
  const rows = await ro(`MATCH (r:Resource {sim:$sim}) RETURN r.owner AS owner, r.type AS type, r.qty AS qty, r.initialQty AS init`, { sim });
  const checks: IntegrityReport["checks"] = [];

  const neg = rows.filter((r) => r.qty < 0);
  checks.push({ name: "no negative balances", ok: neg.length === 0, detail: neg.length ? neg.map((r) => `${r.owner}:${r.type}=${r.qty}`).join(", ") : `${rows.length} balances ≥ 0` });

  const bad: string[] = [];
  for (const t of RESOURCES) {
    const now = rows.filter((r) => r.type === t).reduce((a, r) => a + r.qty, 0);
    const init = rows.filter((r) => r.type === t).reduce((a, r) => a + r.init, 0);
    if (now !== init) bad.push(`${t}: ${now} ≠ ${init}`);
  }
  checks.push({ name: "resource totals conserved", ok: bad.length === 0, detail: bad.length ? bad.join("; ") : "food, wood, tools totals equal their initial totals" });

  const w = await getWorldState(sim);
  const dealBad: string[] = [];
  for (const d of w.deals) {
    if (d.proposerDelivered > d.giveQty || d.counterpartyDelivered > d.getQty) dealBad.push(`${d.id} over-delivered`);
    if (d.state === "fulfilled" && (d.proposerDelivered !== d.giveQty || d.counterpartyDelivered !== d.getQty)) dealBad.push(`${d.id} fulfilled but incomplete`);
    if (d.state === "broken" && !d.defaulter) dealBad.push(`${d.id} broken without defaulter`);
    if (d.state === "proposed" && (d.proposerDelivered || d.counterpartyDelivered)) dealBad.push(`${d.id} delivered before acceptance`);
  }
  checks.push({ name: "deal states consistent with deliveries", ok: dealBad.length === 0, detail: dealBad.length ? dealBad.join("; ") : `${w.deals.length} deals checked` });

  const evs = await ro(`MATCH (e:Event {sim:$sim}) WHERE e.type IN ['TRANSFER','ALLOCATION'] RETURN e`, { sim });
  const expected = new Map<string, number>(rows.map((r) => [`${r.owner}:${r.type}`, r.init as number]));
  for (const e of evs) {
    const d = JSON.parse(P(e.e).data);
    expected.set(`${d.from}:${d.resource}`, (expected.get(`${d.from}:${d.resource}`) ?? 0) - d.qty);
    expected.set(`${d.to}:${d.resource}`, (expected.get(`${d.to}:${d.resource}`) ?? 0) + d.qty);
  }
  const mism = rows.filter((r) => expected.get(`${r.owner}:${r.type}`) !== r.qty).map((r) => `${r.owner}:${r.type} ledger=${expected.get(`${r.owner}:${r.type}`)} actual=${r.qty}`);
  checks.push({ name: "event log reconciles with balances", ok: mism.length === 0, detail: mism.length ? mism.join("; ") : `${evs.length} transfer events replay to the exact balances` });

  return { ok: checks.every((c) => c.ok), checks };
}
