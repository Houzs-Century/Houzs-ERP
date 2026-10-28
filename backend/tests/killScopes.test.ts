import { describe, expect, test } from "vitest";
import { isScopeKilled } from "../src/services/agents/kill-scopes";

/* §10.6 wants the kill switch to reach a COMPANY / class / tool, not just the
   whole fleet. The property worth pinning is the FAILURE DIRECTION: a scope we
   cannot read must be treated as STOPPED. A kill switch that fails open is not a
   kill switch — it is a comment with a database behind it.

   (Note the deliberate asymmetry with the family pause, which fails OPEN so a
   blip cannot silently halt everything. A targeted scope is a narrow, deliberate
   stop, so its failure mode is the cautious one.) */

function stubDb(row: unknown, opts: { throws?: boolean } = {}) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (opts.throws) throw new Error("relation agent_kill_scopes does not exist");
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
}

describe("isScopeKilled", () => {
  test("a paused scope is killed, and carries its reason", async () => {
    const r = await isScopeKilled(stubDb({ paused: 1, reason: "2990 data migration in progress" }), "COMPANY", 7);
    expect(r.killed).toBe(true);
    expect(r.reason).toContain("2990");
  });

  test("a scope row that is NOT paused is clear", async () => {
    const r = await isScopeKilled(stubDb({ paused: 0, reason: null }), "COMPANY", 7);
    expect(r.killed).toBe(false);
  });

  test("no row at all = never stopped = clear", async () => {
    const r = await isScopeKilled(stubDb(null), "COMPANY", 7);
    expect(r.killed).toBe(false);
  });

  test("THE ONE THAT MATTERS: an unreadable scope table is treated as STOPPED", async () => {
    const r = await isScopeKilled(stubDb(null, { throws: true }), "COMPANY", 7);
    expect(r.killed).toBe(true);
    expect(r.reason).toMatch(/treating COMPANY 7 as stopped/);
  });

  test("no scope value to match is not a kill (nothing was scoped)", async () => {
    // A proposal with no company is not 'every company killed' — it is unscoped.
    expect((await isScopeKilled(stubDb(null), "COMPANY", null)).killed).toBe(false);
    expect((await isScopeKilled(stubDb(null), "COMPANY", "")).killed).toBe(false);
  });
});
