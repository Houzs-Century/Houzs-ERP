import { describe, expect, test } from "vitest";
import { staleStopSweepFor } from "../src/scm/routes/delivery-planning";

/* A RE-SCHEDULE MUST NOT STRAND A STOP.
 *
 * `scheduleOntoTrip` de-dups a SO/DO stop within ONE trip. Re-pointing a
 * delivery at a different lorry (or a different date) resolves to a DIFFERENT
 * trip, so the stop written for the previous one used to stay behind: the order
 * sat on two trips at once, and lorry-capacity counted it as two deliveries and
 * added its revenue twice — the fleet number the whole feature exists to make
 * honest, quietly inflated. #947 fixed this for ASSR legs and deliberately left
 * the SO/DO path untouched; this is that path.
 *
 * WHAT IS PINNED HERE, AND WHAT IS NOT. The sweep's FILTER is the dangerous
 * part — a delete that is one predicate too wide takes another document's stops
 * — so the filter is a pure function and is tested as one. What CANNOT be tested
 * here is the delete actually running against a database: this suite binds D1
 * (see vitest.config.ts, DATABASE_URL pinned to ""), and every scm route reads
 * Postgres through `c.get('supabase')`. #947 reported the same gap for the ASSR
 * twin. The runtime behaviour is verified on staging, not by this file — see the
 * PR body. Claiming otherwise would be the kind of test that proves nothing.
 *
 * The source assertions at the bottom exist because a pure function nothing
 * calls is decoration. They pin that the sweep is WIRED INTO the write path with
 * the predicates it was written to carry. Same technique, and same reason, as
 * tests/scheduleScopeRuling.test.ts.
 */

const DO_UUID = "1f0a2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const SO_UUID = "9a8b7c6d-5e4f-4321-9876-543210fedcba";

describe("staleStopSweepFor — which rows a re-schedule may delete", () => {
  test("a DO sweeps on its own do_id, and on the DELIVERY stop type", () => {
    const s = staleStopSweepFor(DO_UUID, null);
    expect(s.state).toBe("SWEEP");
    if (s.state !== "SWEEP") return;
    expect(s.column).toBe("do_id");
    expect(s.value).toBe(DO_UUID);
    /* stop_type is not decoration. Without it the delete would also take this
       same order's stops of another type — a PICKUP raised for the same DO is a
       different job on a different trip, not a stale copy of this one. */
    expect(s.stopType).toBe("DELIVERY");
  });

  test("no key at all is REFUSED, not widened", () => {
    /* THE TEST THIS FILE IS FOR. A `type: 'so'` schedule reaches here with both
       uuids null — scm.mfg_sales_orders has a TEXT PK (doc_no) and no `id`
       column, so there is nothing to write into so_id and the insert is skipped
       by its own `(doId || soId)` guard. There is no stranded stop to clear
       because no stop was ever written, and a sweep attempted anyway would carry
       `.eq('do_id', null)` — a predicate that does not mean what a reader
       assumes. The only safe answer to "delete this order's stops" when the
       order cannot be named is: do not. */
    const s = staleStopSweepFor(null, null);
    expect(s.state).toBe("NO_KEY");
    if (s.state !== "NO_KEY") return;
    expect(s.reason).toBeTruthy();
    // NO_KEY carries no column and no value, so there is nothing for a caller to
    // accidentally pass to a delete.
    expect(Object.prototype.hasOwnProperty.call(s, "column")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(s, "value")).toBe(false);
  });

  test("an empty-string uuid is treated as no key, not as a value to match on", () => {
    // A blank read is ignorance, not an identity. Matching on '' would be a
    // delete keyed on a document that does not exist.
    const s = staleStopSweepFor("", "");
    expect(s.state).toBe("NO_KEY");
  });

  test("do_id wins when both are present — the key the stop was WRITTEN by", () => {
    /* The insert and the single-trip de-dup both prefer do_id (`doId ? … : …`).
       The sweep has to agree with them: keying on the other column would look
       for the row under a name nothing ever stored it under, and quietly sweep
       nothing while reporting success. */
    const s = staleStopSweepFor(DO_UUID, SO_UUID);
    expect(s.state).toBe("SWEEP");
    if (s.state !== "SWEEP") return;
    expect(s.column).toBe("do_id");
    expect(s.value).toBe(DO_UUID);
  });

  test("so_id is used only when there is no do_id", () => {
    const s = staleStopSweepFor(null, SO_UUID);
    expect(s.state).toBe("SWEEP");
    if (s.state !== "SWEEP") return;
    expect(s.column).toBe("so_id");
    expect(s.value).toBe(SO_UUID);
  });

  test("the sweep column is never anything but do_id or so_id", () => {
    /* An ASSR stop is keyed by assr_case_id (mig 0166) and carries do_id/so_id
       NULL. If this function ever learned to return that column, an SO/DO
       re-schedule could reach a service case's stops. The two paths de-dup on
       different keys ON PURPOSE; they are not mirrors. */
    for (const args of [[DO_UUID, null], [null, SO_UUID], [DO_UUID, SO_UUID]] as const) {
      const s = staleStopSweepFor(args[0], args[1]);
      if (s.state !== "SWEEP") throw new Error("expected a sweep");
      const column: string = s.column;
      expect(["do_id", "so_id"]).toContain(column);
      expect(column).not.toBe("assr_case_id");
    }
  });
});

/* ── The sweep is actually wired into the write path ───────────────────────────
   `?raw` is expanded by Vite at TRANSFORM time, in Node, so the file contents are
   baked into the bundle — this suite runs in workerd, where fs throws. Same
   technique as tests/scheduleScopeRuling.test.ts. */
const sources = import.meta.glob("../src/scm/routes/delivery-planning.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? "";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The SO/DO wiring helper's body: from its declaration to the ASSR twin that
 *  follows it. Slicing matters — asserting over the whole file would let
 *  scheduleAssrOntoTrip's delete (added by #947) stand in for the one this PR is
 *  about, and the suite would pass with the SO/DO path still broken. */
function scheduleOntoTripSource(): string {
  const start = routeSource.indexOf("async function scheduleOntoTrip(");
  expect(start, "scheduleOntoTrip not found — was it renamed?").toBeGreaterThan(-1);
  const rest = routeSource.slice(start);
  const end = rest.indexOf("async function scheduleAssrOntoTrip(");
  return stripComments(end === -1 ? rest : rest.slice(0, end));
}

describe("scheduleOntoTrip — the sweep runs on the SO/DO path", () => {
  test("the source loaded (a silent empty glob must not pass)", () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("async function scheduleOntoTrip(");
  });

  test("the slice is the SO/DO path and NOT the ASSR twin", () => {
    const body = scheduleOntoTripSource();
    expect(body.length).toBeGreaterThan(500);
    // #947's fix lives in the other function; if it leaked into this slice the
    // assertions below would be testing the wrong path.
    expect(body).not.toContain("assr_case_id");
  });

  test("it deletes the order's stops on every OTHER trip", () => {
    const body = scheduleOntoTripSource();
    expect(
      body,
      "the stale-stop delete is gone from scheduleOntoTrip. Without it a " +
        "re-schedule leaves the old stop on the previous trip and lorry " +
        "capacity counts the job twice. See BUG-HISTORY.md and " +
        "docs/modules/delivery-tms.md.",
    ).toContain("staleStopSweepFor");
    expect(body).toContain(".delete()");
    // The three predicates, together: this order's uuid, this stop type, and
    // NOT the trip it was just placed on. Drop any one and the delete is either
    // too wide or a no-op.
    expect(body).toContain("sweep.column, sweep.value");
    expect(body).toContain("'stop_type', sweep.stopType");
    expect(body).toContain(".neq('trip_id', tripIdStr)");
  });

  test("the delete only runs when the sweep produced a key", () => {
    // NO_KEY must never reach the database layer.
    expect(scheduleOntoTripSource()).toContain("sweep.state === 'SWEEP'");
  });

  test("a delete failure is REPORTED, not swallowed", () => {
    /* The new stop is written by then, so the operator sees a scheduled job
       while the old one is still on another lorry's sheet. Returning FAILED is
       what puts that on screen (tripFieldsFor → tripWiring.failed) instead of
       leaving it to be discovered by the driver. Matches #947. */
    const body = scheduleOntoTripSource();
    expect(body).toContain("staleErr");
    expect(body).toContain("state: 'FAILED'");
  });
});
