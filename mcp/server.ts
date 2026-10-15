// MCP server exposing Memoria's agent tools over stdio. Every tool delegates to the exact same
// validated backend functions the in-app agents use (src/server/tools.ts) — no Cypher is accepted,
// and rejections are recorded as events just like in-app.
//
//   npm run mcp          (FalkorDB must be running)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { toolSchemas, tools, ToolName } from "../src/server/tools";

const DESCRIPTIONS: Record<ToolName, string> = {
  get_world_state: "Read the village: agents, balances, open deals, tasks and shortages for a simulation (from FalkorDB).",
  get_agent_memories: "Retrieve an agent's episodic, semantic (beliefs) and procedural memories with evidence, update history and decisions that used them.",
  find_related_events: "List events related to a deal or an agent (audit trail).",
  propose_deal: "Propose a validated deal (explicit terms, deadline, optional staged-delivery leader). Idempotent per idemKey.",
  respond_to_deal: "Accept, reject or counter a proposed deal as its counterparty. Illegal transitions are rejected.",
  request_agent_handoff: "Create a handoff Task between agents (resolve_shortage / request_proposal).",
  execute_validated_action: "Move resources (deal TRANSFER or Mayor ALLOCATE). Balance, deal state and delivery order are checked atomically.",
  record_outcome_and_memory: "Record a fulfilled/broken deal and write episodic memory, evidence, belief updates and procedure proposals.",
};

const server = new McpServer({ name: "memoria", version: "0.1.0" });

for (const name of Object.keys(tools) as ToolName[]) {
  const schema = toolSchemas[name] as unknown as { shape: Record<string, any> };
  server.registerTool(name, { description: DESCRIPTIONS[name], inputSchema: schema.shape }, async (args: any) => {
    try {
      const result = await (tools[name] as (a: any) => Promise<unknown>)(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: `Rejected: ${(e as Error).message}` }] };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error("memoria MCP server ready (stdio)");
