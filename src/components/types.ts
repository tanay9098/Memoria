export type { WorldState, EventView, AgentView, DealView, TaskView } from "@/server/world";
export type { MemoryItem } from "@/server/memory";
export type { EvalReport, EvalRow } from "@/server/evaluation";
export type { ConcurrencyReport } from "@/server/concurrency";
export type { IntegrityReport } from "@/server/integrity";

export interface StateResponse {
  world: import("@/server/world").WorldState;
  events: import("@/server/world").EventView[];
  rounds: Record<number, string>;
  scenarios: { id: string; title: string }[];
}
export interface GraphNode { id: string; kind: string; label: string; status?: string; round?: number; agent?: string }
export interface GraphEdge { id: string; source: string; target: string; type: string; role?: string }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }
export interface TraceData {
  decisions: { uid: string; agent: string; round: number; session: number; action: string; rationale: string; source: string; memoryEnabled: boolean; role: string; responds?: string; produced?: string; llmNote?: string }[];
  events: import("@/server/world").EventView[];
}
export interface Health {
  falkordb: { ok: boolean; error?: string; host: string; graph: string };
  llm: { configured: boolean; model: string | null };
  simulation: { id: string; exists: boolean };
}
export const AGENT_COLOR: Record<string, string> = { farmer: "var(--color-farmer)", trader: "var(--color-trader)", mayor: "var(--color-mayor)" };
