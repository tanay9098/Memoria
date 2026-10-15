import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { GraphUnavailableError } from "@/lib/falkor";
import { config } from "@/lib/config";
import { NotFoundError, ValidationError } from "./world";

export const simParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).default(config.defaultSim);
export const getSim = (req: Request) => simParam.parse(new URL(req.url).searchParams.get("sim") ?? undefined);

/** Uniform JSON error mapping so the UI can show a specific, actionable message. */
export async function handle(fn: () => Promise<unknown>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    if (e instanceof GraphUnavailableError) return NextResponse.json({ error: e.message, code: "graph_unavailable" }, { status: 503 });
    if (e instanceof ZodError) return NextResponse.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), code: "invalid_input" }, { status: 400 });
    if (e instanceof NotFoundError) return NextResponse.json({ error: e.message, code: "not_found" }, { status: 404 });
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message, code: "rejected" }, { status: 409 });
    console.error(e);
    return NextResponse.json({ error: (e as Error).message ?? "Internal error", code: "internal" }, { status: 500 });
  }
}
