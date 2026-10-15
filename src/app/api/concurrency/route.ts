import { handle } from "@/server/api";
import { runConcurrencyTests } from "@/server/concurrency";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const POST = () => handle(() => runConcurrencyTests(12));
