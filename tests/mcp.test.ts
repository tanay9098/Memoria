import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { closeAll } from "@/lib/falkor";
import { getWorldState } from "@/server/world";
import { seeded, wipeSimulation } from "./helpers";

let sim: string;
let client: Client;
beforeAll(async () => {
  sim = await seeded("mcp");
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: path.resolve("node_modules/.bin/tsx"), args: [path.resolve("mcp/server.ts")], env: { ...process.env } as Record<string, string>,
  }));
}, 60000);
afterAll(async () => { await client.close(); await wipeSimulation(sim); await closeAll(); });

describe("MCP server uses the same validated backend", () => {
  it("lists the eight tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "execute_validated_action", "find_related_events", "get_agent_memories", "get_world_state",
      "propose_deal", "record_outcome_and_memory", "request_agent_handoff", "respond_to_deal",
    ]);
  });

  it("reads from FalkorDB and performs a validated write through MCP", async () => {
    const ws: any = await client.callTool({ name: "get_world_state", arguments: { sim } });
    expect(JSON.parse(ws.content[0].text).agents[0].resources.food).toBe(40);
    const ok: any = await client.callTool({ name: "execute_validated_action", arguments: { sim, actor: "mayor", action: { kind: "ALLOCATE", from: "mayor", to: "farmer", resource: "food", qty: 4, idemKey: "mcp-1" } } });
    expect(ok.isError).toBeFalsy();
    expect((await getWorldState(sim)).agents[0].resources.food).toBe(44);
  });

  it("rejects invalid and unauthorised calls (no state change)", async () => {
    const bad: any = await client.callTool({ name: "execute_validated_action", arguments: { sim, actor: "mayor", action: { kind: "ALLOCATE", from: "mayor", to: "farmer", resource: "food", qty: 500, idemKey: "mcp-2" } } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/insufficient/);
    const unknown: any = await client.callTool({ name: "execute_validated_action", arguments: { sim, actor: "mayor", action: { kind: "RUN_CYPHER", query: "MATCH (n) DETACH DELETE n" } } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    expect(unknown.isError).toBe(true);
    expect((await getWorldState(sim)).agents[0].resources.food).toBe(44);
  });
});
