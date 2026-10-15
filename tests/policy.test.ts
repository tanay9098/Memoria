import { describe, expect, it } from "vitest";
import { stagedPlan, assessSecurity, EMPTY_MEMORY } from "@/server/policy";
import { reliability } from "@/server/memory";

describe("reliability rule", () => {
  it("matches the documented formula (broken weighs 3)", () => {
    expect(reliability(0, 0)).toBe(0.5);
    expect(reliability(2, 0)).toBe(0.75);
    expect(reliability(2, 1)).toBe(0.43);
  });
});

describe("stagedPlan", () => {
  it("keeps the follower at or behind the leader and totals match", () => {
    const plan = stagedPlan(8, 4);
    expect(plan).toEqual([{ leader: 4, follower: 2 }, { leader: 4, follower: 2 }]);
    const odd = stagedPlan(6, 3);
    expect(odd.reduce((a, p) => a + p.leader, 0)).toBe(6);
    expect(odd.reduce((a, p) => a + p.follower, 0)).toBe(3);
    let l = 0, f = 0;
    for (const p of odd) { l += p.leader; f += p.follower; expect(f * 6).toBeLessThanOrEqual(l * 3); }
  });
});

describe("assessSecurity with no memory", () => {
  it("never demands security without retrieved memory", () => {
    expect(assessSecurity("trader", 100, EMPTY_MEMORY).needed).toBe(false);
  });
});
