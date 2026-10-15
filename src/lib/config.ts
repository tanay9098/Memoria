// Server-side configuration. Nothing here is ever sent to the browser.
export const config = {
  falkor: {
    host: process.env.FALKORDB_HOST ?? "localhost",
    port: Number(process.env.FALKORDB_PORT ?? 6379),
    password: process.env.FALKORDB_PASSWORD || undefined,
    graph: process.env.FALKORDB_GRAPH ?? "memoria",
    pool: Number(process.env.FALKORDB_POOL ?? 4),
  },
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    model: process.env.MEMORIA_LLM_MODEL ?? "claude-opus-5-5",
  },
  defaultSim: "village-1",
};
