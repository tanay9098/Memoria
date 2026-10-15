import { FalkorDB } from "falkordb";
import { config } from "./config";

type Params = Record<string, unknown>;
export type Row = Record<string, any>;

export class GraphUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `FalkorDB is unreachable at ${config.falkor.host}:${config.falkor.port}. ` +
        `Start it with \`docker compose up -d\` (see README). Cause: ${(cause as Error)?.message ?? cause}`,
    );
    this.name = "GraphUnavailableError";
  }
}

const g = globalThis as unknown as {
  __memoriaPool?: Promise<FalkorDB>[];
  __memoriaNext?: number;
  __memoriaSchema?: Promise<void>;
};

function connect(): Promise<FalkorDB> {
  return FalkorDB.connect({
    socket: { host: config.falkor.host, port: config.falkor.port },
    password: config.falkor.password,
  });
}

/**
 * Small connection pool (round-robin). Separate sockets mean concurrent requests really reach
 * FalkorDB in parallel, which is what the concurrency test relies on.
 */
export function client(): Promise<FalkorDB> {
  if (!g.__memoriaPool) {
    g.__memoriaPool = Array.from({ length: config.falkor.pool }, (_, i) =>
      connect().catch((e) => {
        if (g.__memoriaPool) g.__memoriaPool[i] = undefined as any; // allow reconnect on next call
        throw new GraphUnavailableError(e);
      }),
    );
    g.__memoriaNext = 0;
  }
  const i = (g.__memoriaNext = ((g.__memoriaNext ?? 0) + 1) % g.__memoriaPool.length);
  const slot = g.__memoriaPool[i];
  if (!slot) {
    g.__memoriaPool[i] = connect().catch((e) => { g.__memoriaPool![i] = undefined as any; throw new GraphUnavailableError(e); });
    return g.__memoriaPool[i];
  }
  return slot;
}

export async function closeAll() {
  const pool = g.__memoriaPool ?? [];
  g.__memoriaPool = undefined;
  await Promise.all(pool.map((p) => p?.then((c) => c.close()).catch(() => undefined)));
}

/** A dedicated connection (used by the concurrency test to get truly parallel sockets). */
export async function newClient(): Promise<FalkorDB> {
  try {
    return await connect();
  } catch (e) {
    throw new GraphUnavailableError(e);
  }
}

export async function graphOn(c: FalkorDB) {
  return c.selectGraph(config.falkor.graph);
}

/** Run a (parameterized) write/read query. Rows are plain objects keyed by RETURN alias. */
export async function q<T = Row>(cypher: string, params: Params = {}): Promise<T[]> {
  await ensureSchema();
  const c = await client();
  const res = await c.selectGraph(config.falkor.graph).query<T>(cypher, { params: params as any });
  return (res.data ?? []) as T[];
}

/** Read-only variant (GRAPH.RO_QUERY) — the server rejects any write. */
export async function ro<T = Row>(cypher: string, params: Params = {}): Promise<T[]> {
  await ensureSchema();
  const c = await client();
  const res = await c.selectGraph(config.falkor.graph).roQuery<T>(cypher, { params: params as any });
  return (res.data ?? []) as T[];
}

export async function qOn<T = Row>(c: FalkorDB, cypher: string, params: Params = {}): Promise<T[]> {
  const res = await c.selectGraph(config.falkor.graph).query<T>(cypher, { params: params as any });
  return (res.data ?? []) as T[];
}

export const LABELS = [
  "Simulation", "Agent", "Resource", "Deal", "Event", "Memory", "Knowledge",
  "Procedure", "Task", "Evidence", "Decision", "Session", "Revision", "EvalRun",
] as const;

/**
 * Index + UNIQUE constraint on `uid` for every label. uid = "<sim>|<localId>", so
 * the same logical entity can never be created twice (this is what makes retried
 * writes safe: a duplicate CREATE is rejected by FalkorDB itself).
 */
export function ensureSchema(): Promise<void> {
  if (!g.__memoriaSchema) {
    g.__memoriaSchema = (async () => {
      const c = await client();
      const gr = c.selectGraph(config.falkor.graph);
      for (const label of LABELS) {
        try { await gr.query(`CREATE INDEX FOR (n:${label}) ON (n.uid)`); }
        catch (e) { if (!/already indexed/i.test((e as Error).message)) throw e; }
        try { await gr.constraintCreate("UNIQUE" as any, "NODE" as any, label, "uid"); }
        catch (e) { if (!/already exists/i.test((e as Error).message)) throw e; }
      }
      for (const label of ["Event", "Deal", "Memory"]) {
        try { await gr.query(`CREATE INDEX FOR (n:${label}) ON (n.sim)`); }
        catch (e) { if (!/already indexed/i.test((e as Error).message)) throw e; }
      }
    })().catch((e) => { g.__memoriaSchema = undefined; throw e; });
  }
  return g.__memoriaSchema;
}

export async function ping(): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureSchema();
    await ro("RETURN 1 AS ok");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const uid = (sim: string, id: string) => `${sim}|${id}`;
