import { q, ro, uid } from "@/lib/falkor";
import { handoffSchema } from "@/lib/domain";
import { EVENT_CLAUSE, evParams, P } from "./events";
import { NotFoundError, TaskView, ValidationError, agentUid, requireSim, simUid } from "./world";
import { nm } from "./deals";

const taskView = (t: any): TaskView => ({
  id: t.id, kind: t.kind, state: t.state, from: t.from, to: t.to, round: t.round, dependsOn: t.dependsOn || null,
  payload: JSON.parse(t.payload || "{}"),
});

/** request_agent_handoff: Task node + HANDED_OFF_TO / ASSIGNED_TO edges, atomically with its event. */
export async function requestHandoff(sim: string, actor: string, raw: unknown): Promise<{ task: TaskView; replayed: boolean }> {
  await requireSim(sim);
  const h = handoffSchema.parse(raw);
  if (h.from !== actor) throw new ValidationError(`${actor} cannot hand off on behalf of ${h.from}`);
  if (h.from === h.to) throw new ValidationError("Cannot hand off to yourself");
  const evKey = `handoff:${h.idemKey}`;
  const existing = await ro(`MATCH (e:Event {uid:$u})-[:AFFECTED]->(t:Task) RETURN t`, { u: uid(sim, `ev|${evKey}`) });
  if (existing.length) return { task: taskView(P(existing[0].t)), replayed: true };
  if (h.dependsOn) {
    const dep = await ro(`MATCH (t:Task {uid:$u}) RETURN t.state AS st`, { u: uid(sim, `task|${h.dependsOn}`) });
    if (!dep.length) throw new NotFoundError(`Task ${h.dependsOn}`);
  }
  const p = evParams(sim, {
    key: evKey, type: "HANDOFF_REQUESTED", actor: h.from, outcome: "confirmed",
    summary: `${nm(h.from)} handed off "${h.kind.replace("_", " ")}" to ${nm(h.to)}`, data: { kind: h.kind, to: h.to, payload: h.payload },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid})
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, old WHERE old IS NULL
     SET sim.taskSeq = sim.taskSeq + 1
     CREATE (t:Task {uid: sim.id + '|task|T-' + toString(sim.taskSeq), id:'T-' + toString(sim.taskSeq), n: sim.taskSeq, sim:$sim,
       kind:$kind, state:'open', from:$from, to:$to, round:sim.round, dependsOn:$dependsOn, payload:$payload})
     CREATE (sim)-[:HAS_TASK]->(t)
     WITH sim, t
     MATCH (fa:Agent {uid:$fromUid}), (ta:Agent {uid:$toUid})
     CREATE (fa)-[:HANDED_OFF_TO {task: t.id}]->(ta), (t)-[:ASSIGNED_TO]->(ta), (fa)-[:REQUESTED]->(t)
     WITH sim, t, fa
     ${EVENT_CLAUSE}
     CREATE (fa)-[:PERFORMED]->(ev), (ev)-[:AFFECTED]->(t)
     WITH t
     OPTIONAL MATCH (dep:Task {uid:$depUid})
     FOREACH (_ IN CASE WHEN dep IS NULL THEN [] ELSE [1] END | CREATE (t)-[:DEPENDS_ON]->(dep))
     RETURN t`,
    { ...p, kind: h.kind, from: h.from, to: h.to, dependsOn: h.dependsOn ?? "", payload: JSON.stringify(h.payload),
      fromUid: agentUid(sim, h.from), toUid: agentUid(sim, h.to), depUid: h.dependsOn ? uid(sim, `task|${h.dependsOn}`) : "" },
  );
  if (!rows.length) {
    const again = await ro(`MATCH (e:Event {uid:$u})-[:AFFECTED]->(t:Task) RETURN t`, { u: uid(sim, `ev|${evKey}`) });
    if (again.length) return { task: taskView(P(again[0].t)), replayed: true };
    throw new ValidationError("Handoff not applied");
  }
  return { task: taskView(P(rows[0].t)), replayed: false };
}

export async function completeTask(sim: string, actor: string, taskId: string, result: string): Promise<TaskView> {
  const tu = uid(sim, `task|${taskId}`);
  const cur = await ro(`MATCH (t:Task {uid:$u}) RETURN t`, { u: tu });
  if (!cur.length) throw new NotFoundError(`Task ${taskId}`);
  const t = taskView(P(cur[0].t));
  if (t.to !== actor) throw new ValidationError(`Task ${taskId} is assigned to ${t.to}, not ${actor}`);
  if (t.state === "done") return t;
  const p = evParams(sim, {
    key: `taskdone:${taskId}`, type: "TASK_COMPLETED", actor, outcome: "confirmed",
    summary: `${nm(actor)} completed ${taskId} (${t.kind.replace("_", " ")}): ${result}`, data: { taskId, result },
  });
  const rows = await q(
    `MATCH (sim:Simulation {uid:$simUid}), (t:Task {uid:$tu}) WHERE t.state = 'open'
     OPTIONAL MATCH (old:Event {uid:$evUid})
     WITH sim, t, old WHERE old IS NULL
     SET t.state = 'done', t.result = $result
     WITH sim, t
     ${EVENT_CLAUSE}
     CREATE (ev)-[:AFFECTED]->(t)
     RETURN t`,
    { ...p, tu, result },
  );
  if (!rows.length) {
    const now = await ro(`MATCH (t:Task {uid:$u}) RETURN t`, { u: tu });
    return taskView(P(now[0].t));
  }
  return taskView(P(rows[0].t));
}
