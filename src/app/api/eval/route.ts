import { handle } from "@/server/api";
import { latestEvaluation, runEvaluation } from "@/server/evaluation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const GET = () => handle(async () => ({ report: await latestEvaluation() }));
export const POST = () => handle(async () => ({ report: await runEvaluation() }));
