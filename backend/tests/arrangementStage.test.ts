import { describe, expect, test } from "vitest";
import {
  deriveArrangementStage,
  dateSideOf,
  timeSideOf,
  type ArrangementStage,
} from "../src/scm/lib/arrangement-stage";

/* THE DELIVERY ARRANGEMENT PIPELINE — the owner's 2026-08-07 spec, pinned.
 *
 * Every Pending Schedule order needs a delivery DATE arranged (the Delivery
 * Date Arrangement page); once the date is confirmed the order flows into
 * Delivery Time Arrangement (Trips) as work to do; once it is on a trip it is
 * arranged. Four visible sub-states, two per side, ALL DERIVED — no new
 * columns:
 *
 *   in the pipeline = delivery_state === 'PENDING_SCHEDULE' (the shared
 *                     derivePlanningState, untouched by this feature)
 *   dateConfirmed   = amended_delivery_date IS NOT NULL (SO rows — written only
 *                     through PATCH /delivery-planning/so/:id/schedule) or
 *                     dp_orders.requested_date (manual DP jobs)
 *   onActiveTrip    = a DELIVERY trip_stop keyed on one of the order's DO uuids
 *                     sits on a non-CANCELLED trip
 *
 * What is pure is tested as such (the stage truth table + the two side-views).
 * What CANNOT be proven here is the board endpoint resolving the booleans
 * against a database — this suite binds D1 (vitest.config.mts pins
 * DATABASE_URL "") and every scm route reads Postgres through
 * c.get('supabase'); the runtime read is a staging check, the same honest limit
 * tripReconcile.test.ts records. The source assertions at the bottom pin the
 * WIRING instead: the board stamps the stage through this lib (never a forked
 * inline rule), excludes CANCELLED trips, and keys the trip lookup on the same
 * do_id column scheduleOntoTrip writes.
 */

describe("deriveArrangementStage — the four sub-states from representative rows", () => {
  test("PENDING_DATE: ready to ship, no confirmed date, not on a trip", () => {
    /* The fresh Pending Schedule order — goods ready, nobody has arranged a
       date. This is the Delivery Date Arrangement page's queue. */
    expect(deriveArrangementStage({
      deliveryState: "PENDING_SCHEDULE",
      dateConfirmed: false,
      onActiveTrip: false,
    })).toBe("PENDING_DATE");
  });

  test("PENDING_TIME (= Date arranged): date confirmed, not yet on a trip", () => {
    /* 'Apply proposed dates' (or the bulk Delivery-date set) wrote
       amended_delivery_date through the established schedule path. The order is
       done on the date side and is now the Time Arrangement inbox's row. */
    expect(deriveArrangementStage({
      deliveryState: "PENDING_SCHEDULE",
      dateConfirmed: true,
      onActiveTrip: false,
    })).toBe("PENDING_TIME");
  });

  test("TIME_ARRANGED: a DELIVERY stop on a live trip", () => {
    expect(deriveArrangementStage({
      deliveryState: "PENDING_SCHEDULE",
      dateConfirmed: true,
      onActiveTrip: true,
    })).toBe("TIME_ARRANGED");
  });

  test("on a trip DOMINATES a missing date — arranged, not stuck", () => {
    /* A dispatcher can put an order on a lorry from the board's inline Lorry
       cell without ever writing an amended date. That order is arranged — it
       must not sit in the Pending Date queue while a driver carries it. */
    expect(deriveArrangementStage({
      deliveryState: "PENDING_SCHEDULE",
      dateConfirmed: false,
      onActiveTrip: true,
    })).toBe("TIME_ARRANGED");
  });

  test("outside Pending Schedule the stage is null — nothing to arrange", () => {
    for (const state of ["PENDING_DELIVERY", "OVERDUE", "DELIVERED", null, undefined, ""]) {
      expect(deriveArrangementStage({
        deliveryState: state as string | null | undefined,
        dateConfirmed: true,
        onActiveTrip: true,
      })).toBeNull();
    }
  });
});

describe("the two side-views fold the stage, never re-derive it", () => {
  test("date side: PENDING_DATE vs DATE_ARRANGED (PENDING_TIME and TIME_ARRANGED both count as arranged)", () => {
    expect(dateSideOf("PENDING_DATE")).toBe("PENDING_DATE");
    expect(dateSideOf("PENDING_TIME")).toBe("DATE_ARRANGED");
    expect(dateSideOf("TIME_ARRANGED")).toBe("DATE_ARRANGED");
    expect(dateSideOf(null)).toBeNull();
  });

  test("time side: only date-confirmed orders exist for the Time page", () => {
    /* A PENDING_DATE order is not the Time page's yet — the pipeline order is
       date first, then time. It surfaces there only as an 'awaiting date' count,
       never as an inbox row. */
    expect(timeSideOf("PENDING_DATE")).toBeNull();
    expect(timeSideOf("PENDING_TIME")).toBe("PENDING_TIME");
    expect(timeSideOf("TIME_ARRANGED")).toBe("TIME_ARRANGED");
    expect(timeSideOf(null)).toBeNull();
  });

  test("every stage has exactly one date-side and at most one time-side reading", () => {
    const stages: ArrangementStage[] = ["PENDING_DATE", "PENDING_TIME", "TIME_ARRANGED"];
    for (const s of stages) {
      expect(dateSideOf(s)).not.toBeNull();
      // The pipeline is a line, not a lattice: TIME side defined <=> date side done.
      expect(timeSideOf(s) != null).toBe(dateSideOf(s) === "DATE_ARRANGED");
    }
  });
});

/* ── The board actually stamps the stage through THIS lib ─────────────────────
   `?raw` is expanded by Vite at TRANSFORM time, in Node, so the file contents
   are baked into the bundle — this suite runs in workerd, where fs throws. Same
   technique, and same reason, as tests/tripReconcile.test.ts. */
const sources = import.meta.glob("../src/scm/routes/delivery-planning.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const boardSource = Object.values(sources)[0] ?? "";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("delivery-planning.ts — the board stamps the stage, one rule, no fork", () => {
  test("the source loaded (a silent empty glob must not pass)", () => {
    expect(boardSource.length).toBeGreaterThan(1000);
    expect(boardSource).toContain("deriveArrangementStage");
  });

  test("the stage is computed by the shared lib, never an inline re-derivation", () => {
    const stripped = stripComments(boardSource);
    expect(stripped).toContain("from '../lib/arrangement-stage'");
    /* Stamped for the SO rows AND the DP union (the two row types in the
       pipeline) — 2 call sites. ASSR / project rows are stamped null literally
       (they land PENDING_DELIVERY, outside the pipeline). */
    const calls = stripped.split("deriveArrangementStage(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("dateConfirmed is the amended date — the established schedule path's column", () => {
    const stripped = stripComments(boardSource);
    expect(stripped).toContain("dateConfirmed: amendedDD != null");
  });

  test("the trip lookup keys on do_id and drops CANCELLED trips", () => {
    const stripped = stripComments(boardSource);
    /* Same do_id key scheduleOntoTrip writes and staleStopSweepFor sweeps —
       forward write and derived read stay symmetric. (#1720 widened the select
       with stop_no + eta_offset_s — the run-time sort keys; the do_id key is
       the invariant this pin protects.)

       Both reads are CHUNKED now, so the filter names the batch rather than the
       whole list and this pin had to be re-aimed. It is re-aimed in TWO parts,
       not loosened: the filter still has to key on do_id / id, AND the list fed
       to chunkIn still has to be doIds / tripIds. Matching only `batch` would
       have let the read be pointed at some other set without a word. */
    expect(stripped).toContain(".select('dp_no, do_id, trip_id, stop_no, eta_offset_s').in('do_id', batch)");
    expect(stripped).toContain("chunkIn<StopRow>(doIds,");
    /* A CANCELLED trip is no arrangement: the reverse reconcile already returns
       such orders to the queue, and the stage must agree with it. */
    const tripJoinIdx = stripped.indexOf(".select('id, trip_no, trip_date, status').in('id', batch)");
    expect(tripJoinIdx).toBeGreaterThan(-1);
    expect(stripped).toContain("chunkIn<Record<string, unknown>>(tripIds,");
    const after = stripped.slice(tripJoinIdx, tripJoinIdx + 600);
    expect(after).toContain("'CANCELLED'");
  });

  test("the stamped row carries the trip ref beside the stage (trip_id / trip_no / trip_date)", () => {
    const stripped = stripComments(boardSource);
    expect(stripped).toContain("trip_id: tripByDoc.get(docNo)?.id ?? null");
    expect(stripped).toContain("trip_no: tripByDoc.get(docNo)?.trip_no ?? null");
    expect(stripped).toContain("trip_date: tripByDoc.get(docNo)?.trip_date ?? null");
  });
});
