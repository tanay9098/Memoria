import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

describe("FalkorDB unavailable", () => {
  it("fails fast with an actionable error (never falls back to an in-memory graph)", () => {
    const script = `
      import { getWorldState } from "./src/server/world";
      const t = Date.now();
      try { await getWorldState("village-1"); console.log("UNEXPECTED_SUCCESS"); }
      catch (e) { console.log(JSON.stringify({ name: e.name, msg: e.message, ms: Date.now() - t })); }
      process.exit(0);`;
    const out = execFileSync(path.resolve("node_modules/.bin/tsx"), ["--input-type=module", "-e", script], {
      env: { ...process.env, FALKORDB_PORT: "6391" }, encoding: "utf8", timeout: 20000,
    }).trim().split("\n").pop()!;
    const r = JSON.parse(out);
    expect(r.name).toBe("GraphUnavailableError");
    expect(r.msg).toMatch(/docker compose up -d/);
    expect(r.ms).toBeLessThan(5000);
  });
});
