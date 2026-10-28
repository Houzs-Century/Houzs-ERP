import { describe, expect, test } from "vitest";
import { familyDataQuality } from "../src/services/agents/data-quality";

/* The §10.2 gate only protects anything if the signal can actually turn RED.
   Both self-approval paths passed a hard-coded GREEN until now, which made the
   protection inert — a gate that can never close is a comment, not a control.
   These tests pin the one property that matters: every uncertainty resolves
   AWAY from GREEN. A gate that fails open is the same as no gate. */

/** Minimal D1 stub — prepare().bind().first() returning one row (or throwing). */
function stubDb(row: unknown, opts: { throws?: boolean } = {}) {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (opts.throws) throw new Error("relation agent_runs does not exist");
          return row;
        },
      }),
    }),
  } as unknown as D1Database;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("familyDataQuality — GREEN only when evidenced", () => {
  test("a recent successful run is GREEN", async () => {
    const r = await familyDataQuality(stubDb({ status: "ok", started_at: hoursAgo(1) }), "procurement-run", 6);
    expect(r.status).toBe("GREEN");
    expect(r.reason).toContain("succeeded");
  });

  test("dual-read: a camelCased startedAt still dates the run", async () => {
    // The pg driver camelCases result columns — reading only snake_case is the
    // codebase's #1 recurring bug, and here it would fake a stale run.
    const r = await familyDataQuality(stubDb({ status: "ok", startedAt: hoursAgo(1) }), "procurement-run", 6);
    expect(r.status).toBe("GREEN");
  });
});

describe("familyDataQuality — the RED cases stop a self-approval", () => {
  test("the last run ERRORED → RED", async () => {
    const r = await familyDataQuality(stubDb({ status: "error", started_at: hoursAgo(1), error: "mrp read failed" }), "procurement-run", 6);
    expect(r.status).toBe("RED");
    expect(r.reason).toContain("errored");
  });

  test("the family has NEVER run → RED (nothing to act on)", async () => {
    const r = await familyDataQuality(stubDb(null), "si-run", 12);
    expect(r.status).toBe("RED");
    expect(r.reason).toContain("never");
  });

  test("an unreadable run history → RED, not a shrug", async () => {
    // We cannot evidence freshness, so we cannot claim it.
    const r = await familyDataQuality(stubDb(null, { throws: true }), "of-run", 6);
    expect(r.status).toBe("RED");
  });
});

describe("familyDataQuality — staleness is AMBER", () => {
  test("older than twice the cadence → AMBER", async () => {
    // cadence 6h → budget 12h; a 20h-old brief is real but out of date.
    const r = await familyDataQuality(stubDb({ status: "ok", started_at: hoursAgo(20) }), "of-run", 6);
    expect(r.status).toBe("AMBER");
    expect(r.reason).toMatch(/freshness budget/);
  });

  test("inside the budget stays GREEN (one missed beat is a blip)", async () => {
    const r = await familyDataQuality(stubDb({ status: "ok", started_at: hoursAgo(8) }), "of-run", 6);
    expect(r.status).toBe("GREEN");
  });

  test("an undateable run is AMBER — it cannot be SHOWN to be fresh", async () => {
    const r = await familyDataQuality(stubDb({ status: "ok", started_at: "not-a-date" }), "of-run", 6);
    expect(r.status).toBe("AMBER");
  });
});
