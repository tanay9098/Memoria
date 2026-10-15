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
  __memoriaPool?: (Promise<FalkorDB> | undefined)[];
  __memoriaNext?: number;
  __memoriaSchema?: Promise<void>;
};

async function connect(): Promise<FalkorDB> {
  const c = await FalkorDB.connect({
    // Fail fast instead of retrying forever, so the UI can show a clear "FalkorDB unreachable" error.
    socket: {
      host: config.falkor.host, port: config.falkor.port, connectTimeout: 3000,
      reconnectStrategy: (retries: number) => (retries >= 2 ? new Error("connection retries exhausted") : 200),
    } as any,
    password: config.falkor.password,
  });
  // An unhandled 'error' event would crash the process when the DB goes away; failures surface per query instead.
  c.on("error", () => undefined);
  return c;
}

const CONNECTION_ERROR = /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|closed|Socket|Connection|retries exhausted|NR_CLOSED|Reconnect/i;

/** Drop pooled connections (they reconnect lazily on the next call) and surface a clear error. */
async function failConnection(e: unknown): Promise<never> {
  if (e instanceof GraphUnavailableError) throw e;
  if (CONNECTION_ERROR.test((e as Error)?.message ?? "")) {
    const pool = g.__memoriaPool ?? [];
    g.__memoriaPool = undefined;
    g.__memoriaSchema = undefined;
    pool.forEach((p) => p?.then((c) => c.close()).catch(() => undefined));
    throw new GraphUnavailableError(e);
  }
  throw e;
}

/**
 * Small connection pool (round-robin). Separate sockets mean concurrent requests really reach
 * FalkorDB in parallel, which is what the concurrency test relies on.
 */
export function client(): Promise<FalkorDB> {
  const pool = (g.__memoriaPool ??= new Array(config.falkor.pool).fill(undefined));
  const i = (g.__memoriaNext = ((g.__memoriaNext ?? -1) + 1) % pool.length);
  if (!pool[i]) {
    // Slots connect lazily, one per call, so a refused connection is always awaited by its caller.
    pool[i] = connect().catch((e) => {
      pool[i] = undefined;
      throw new GraphUnavailableError(e);
    });
  }
  return pool[i]!;
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
  return withRetry(async () => {
    await ensureSchema();
    const c = await client();
    const res = await c.selectGraph(config.falkor.graph).query<T>(cypher, { params: params as any });
    return (res.data ?? []) as T[];
  });
}

/**
 * Retry once, and only when the failure proves the command was never sent (connection refused / client
 * already closed — e.g. a pooled socket that died while the DB restarted). Mid-flight errors are NOT
 * retried, because a write might have been applied.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (/ECONNREFUSED|client is closed|ClientClosed/i.test((e as Error)?.message ?? "")) {
      await resetPool();
      try { return await fn(); } catch (e2) { return failConnection(e2); }
    }
    return failConnection(e);
  }
}

async function resetPool() {
  const pool = g.__memoriaPool ?? [];
  g.__memoriaPool = undefined;
  g.__memoriaSchema = undefined;
  pool.forEach((p) => p?.then((c) => c.close()).catch(() => undefined));
}

/** Read-only variant (GRAPH.RO_QUERY) — the server rejects any write. */
export async function ro<T = Row>(cypher: string, params: Params = {}): Promise<T[]> {
  return withRetry(async () => {
    await ensureSchema();
    const c = await client();
    const res = await c.selectGraph(config.falkor.graph).roQuery<T>(cypher, { params: params as any });
    return (res.data ?? []) as T[];
  });
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
