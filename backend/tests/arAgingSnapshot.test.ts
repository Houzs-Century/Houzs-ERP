import { describe, expect, test } from "vitest";
import {
  reduceAgingSnapshot,
  emptyOutstandingSummary,
  OUTSTANDING_MODULES,
  type AgingMvRow,
  type OutstandingSummary,
  type OutstandingSummaryEntry,
} from "../src/scm/lib/ar-aging";

/* WHAT THIS SUITE CAN AND CANNOT REACH.
   The scm.mv_ar_aging SQL runs only on Postgres, and this harness is an isolated
   SQLite D1 that never applies migrations-pg — so, exactly like the live
   /outstanding/summary rewrite (#528), the SQL-vs-live byte-equality is a STAGING
   before/after diff, not a unit test (perf-optimization-plan.md rule 2). What IS
   unit-testable, and is locked here:
     1. reduceAgingSnapshot — the reducer that turns MV rows into the summary.
     2. Company scoping BOTH directions — a value in company A must not leak into
        company B's summary, and vice versa.
     3. The MV-rollup == live-aggregate algebra: grouping per company then summing
        (the snapshot path) yields the same per-module totals as aggregating the
        outstanding rows directly (the live path), under every scoping.
     4. The migration ships the CONCURRENTLY enabler + the faithful filters, and
        the cron wires the nightly refresh. */

// ── Independent oracle: hand-written expected summaries ────────────────────
const A = 1; // company id A
const B = 2; // company id B

/** Build a full seven-key summary from a sparse spec (unspecified modules = 0). */
function summaryOf(
  spec: Partial<Record<string, [count: number, total?: number, out?: number]>>,
): OutstandingSummary {
  const s = emptyOutstandingSummary();
  for (const [m, tuple] of Object.entries(spec)) {
    if (!tuple) continue;
    const [count, total = 0, out = 0] = tuple;
    s[m] = { count, total_centi: total, total_outstanding_centi: out };
  }
  return s;
}

// ── Fixtures: the underlying outstanding-view rows the MV aggregates ────────
// Fields mirror what each module's arm reads; only the relevant columns are set.
interface DocFixture {
  company_id: number;
  module: string;
  is_outstanding: boolean;
  status?: string; // si only — the DRAFT leak-guard
  total_centi?: number; // po/pi/si amount
  local_total_centi?: number; // so amount
  outstanding_centi?: number; // pi/si net outstanding
}

const FIXTURES: DocFixture[] = [
  // SI — DRAFT excluded by the leak-guard; PAID excluded by is_outstanding.
  { company_id: A, module: "si", is_outstanding: true, status: "PARTIALLY_PAID", total_centi: 10000, outstanding_centi: 4000 },
  { company_id: A, module: "si", is_outstanding: true, status: "POSTED", total_centi: 5000, outstanding_centi: 5000 },
  { company_id: A, module: "si", is_outstanding: true, status: "DRAFT", total_centi: 9999, outstanding_centi: 9999 },
  { company_id: A, module: "si", is_outstanding: false, status: "PAID", total_centi: 7000, outstanding_centi: 0 },
  { company_id: B, module: "si", is_outstanding: true, status: "POSTED", total_centi: 8000, outstanding_centi: 8000 },
  // SO — local_total_centi; one non-outstanding row excluded.
  { company_id: A, module: "so", is_outstanding: true, local_total_centi: 20000 },
  { company_id: A, module: "so", is_outstanding: true, local_total_centi: 30000 },
  { company_id: B, module: "so", is_outstanding: false, local_total_centi: 99999 },
  // PR — count only. Present for A, ABSENT for B (drives the scoping-both-ways test).
  { company_id: A, module: "pr", is_outstanding: true },
  // PI — present for B, ABSENT for A (the other scoping direction).
  { company_id: B, module: "pi", is_outstanding: true, total_centi: 12000, outstanding_centi: 3000 },
];

// Expected summaries, computed BY HAND from the fixtures above.
const EXPECT_A = summaryOf({
  si: [2, 15000, 9000], // PARTIALLY_PAID + POSTED; DRAFT & PAID dropped
  so: [2, 50000, 0],
  pr: [1, 0, 0],
});
const EXPECT_B = summaryOf({
  si: [1, 8000, 8000],
  pi: [1, 12000, 3000],
});
const EXPECT_ALL = summaryOf({
  si: [3, 23000, 17000],
  so: [2, 50000, 0],
  pr: [1, 0, 0],
  pi: [1, 12000, 3000],
});

// ── MV model: what the SQL materialized view produces, one row per (co, module).
// The count/amount/outstanding column mapping mirrors the MV arms (== SUMMARY_AGG).
const AMOUNT_FIELD: Record<string, keyof DocFixture | null> = {
  po: "total_centi", grn: null, pi: "total_centi", pr: null,
  so: "local_total_centi", do: null, si: "total_centi",
};
const OUTSTANDING_FIELD: Record<string, keyof DocFixture | null> = {
  po: null, grn: null, pi: "outstanding_centi", pr: null,
  so: null, do: null, si: "outstanding_centi",
};

interface MvRow extends AgingMvRow {
  company_id: number;
}

function buildMvRows(fixtures: DocFixture[]): MvRow[] {
  const groups = new Map<string, MvRow>();
  for (const f of fixtures) {
    if (!f.is_outstanding) continue; // WHERE is_outstanding
    if (f.module === "si" && f.status === "DRAFT") continue; // SI DRAFT leak-guard
    const key = `${f.company_id}:${f.module}`;
    const row = groups.get(key) ?? {
      company_id: f.company_id, module: f.module, cnt: 0, total_centi: 0, total_outstanding_centi: 0,
    };
    const amtField = AMOUNT_FIELD[f.module];
    const outField = OUTSTANDING_FIELD[f.module];
    row.cnt = Number(row.cnt) + 1;
    row.total_centi = Number(row.total_centi) + (amtField ? Number(f[amtField] ?? 0) : 0);
    row.total_outstanding_centi =
      Number(row.total_outstanding_centi) + (outField ? Number(f[outField] ?? 0) : 0);
    groups.set(key, row);
  }
  return [...groups.values()];
}

/** scopeToCompany's effect on the MV read: resolved company X → only its rows;
 *  unresolved (undefined) → every row. */
function scopeRows(rows: MvRow[], companyId?: number): MvRow[] {
  return companyId == null ? rows : rows.filter((r) => r.company_id === companyId);
}

// ────────────────────────────────────────────────────────────────────────────

describe("reduceAgingSnapshot", () => {
  test("empty input → all seven module keys, zeroed", () => {
    const s = reduceAgingSnapshot([]);
    expect(Object.keys(s).sort()).toEqual([...OUTSTANDING_MODULES].sort());
    for (const m of OUTSTANDING_MODULES) {
      expect(s[m]).toEqual({ count: 0, total_centi: 0, total_outstanding_centi: 0 });
    }
  });

  test("sums multiple company rows for the same module (the all-companies collapse)", () => {
    const s = reduceAgingSnapshot([
      { module: "pi", cnt: 2, total_centi: 100, total_outstanding_centi: 40 },
      { module: "pi", cnt: 3, total_centi: 200, total_outstanding_centi: 70 },
    ]);
    expect(s.pi).toEqual({ count: 5, total_centi: 300, total_outstanding_centi: 110 });
  });

  test("tolerates PostgREST bigint-as-string and ignores unknown module labels", () => {
    const s = reduceAgingSnapshot([
      { module: "si", cnt: "4", total_centi: "999", total_outstanding_centi: "5" },
      { module: "xx", cnt: 9, total_centi: 9, total_outstanding_centi: 9 } as AgingMvRow,
    ]);
    expect(s.si).toEqual({ count: 4, total_centi: 999, total_outstanding_centi: 5 });
    expect(Object.keys(s)).not.toContain("xx");
  });
});

describe("snapshot == live aggregation on seeded fixtures", () => {
  const mvAll = buildMvRows(FIXTURES);

  test("company A: snapshot totals equal the hand-computed live totals", () => {
    expect(reduceAgingSnapshot(scopeRows(mvAll, A))).toEqual(EXPECT_A);
  });

  test("company B: snapshot totals equal the hand-computed live totals", () => {
    expect(reduceAgingSnapshot(scopeRows(mvAll, B))).toEqual(EXPECT_B);
  });

  test("unresolved (no active company): sums ACROSS companies per module", () => {
    expect(reduceAgingSnapshot(scopeRows(mvAll, undefined))).toEqual(EXPECT_ALL);
  });
});

describe("company scoping is isolated in BOTH directions", () => {
  const mvAll = buildMvRows(FIXTURES);

  test("A's PR (which B lacks) appears for A and is 0 for B", () => {
    expect(reduceAgingSnapshot(scopeRows(mvAll, A)).pr.count).toBe(1);
    expect(reduceAgingSnapshot(scopeRows(mvAll, B)).pr.count).toBe(0);
  });

  test("B's PI (which A lacks) appears for B and is 0 for A", () => {
    const forB = reduceAgingSnapshot(scopeRows(mvAll, B)).pi;
    expect(forB).toEqual<OutstandingSummaryEntry>({ count: 1, total_centi: 12000, total_outstanding_centi: 3000 });
    expect(reduceAgingSnapshot(scopeRows(mvAll, A)).pi).toEqual({ count: 0, total_centi: 0, total_outstanding_centi: 0 });
  });

  test("neither company's SI outstanding leaks into the other", () => {
    expect(reduceAgingSnapshot(scopeRows(mvAll, A)).si.total_outstanding_centi).toBe(9000);
    expect(reduceAgingSnapshot(scopeRows(mvAll, B)).si.total_outstanding_centi).toBe(8000);
  });
});

// ── Structural guards: the SQL + cron actually carry the load-bearing pieces ──
// import.meta.glob with ?raw inlines the file text at transform time (Node), so
// it is readable inside the workerd isolate — the same mechanism migrationNumbers
// uses to see the migration listing.
const MIGRATION_SQL = Object.values(
  import.meta.glob("../src/db/migrations-pg/0152_*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>,
)[0];

const INDEX_TS = Object.values(
  import.meta.glob("../src/inde*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>,
)[0];

describe("migration 0152 ships the snapshot correctly", () => {
  test("the migration file was globbed (guards a vacuous pass)", () => {
    expect(typeof MIGRATION_SQL, "0152_*.sql did not glob").toBe("string");
    expect(MIGRATION_SQL.length).toBeGreaterThan(0);
  });

  test("creates the materialized view and its UNIQUE index (the CONCURRENTLY enabler)", () => {
    expect(MIGRATION_SQL).toContain("CREATE MATERIALIZED VIEW scm.mv_ar_aging");
    expect(MIGRATION_SQL).toMatch(/CREATE UNIQUE INDEX[^;]+scm\.mv_ar_aging/);
  });

  test("keeps company_id NULL-free for the unique index and scopes-honest", () => {
    expect(MIGRATION_SQL).toContain("COALESCE(company_id, 0)");
  });

  test("aggregates only outstanding rows and keeps the SI DRAFT leak-guard", () => {
    expect(MIGRATION_SQL).toContain("WHERE is_outstanding");
    expect(MIGRATION_SQL).toContain("status <> 'DRAFT'");
  });

  test("grants the read + seeds the freshness companion + reloads PostgREST", () => {
    expect(MIGRATION_SQL).toContain("GRANT SELECT ON scm.mv_ar_aging TO service_role");
    expect(MIGRATION_SQL).toContain("scm.mv_ar_aging_meta");
    expect(MIGRATION_SQL).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe("the nightly cron wires the concurrent refresh", () => {
  test("02:00 handler refreshes the MV CONCURRENTLY and bumps the freshness row", () => {
    expect(INDEX_TS).toContain("REFRESH MATERIALIZED VIEW CONCURRENTLY scm.mv_ar_aging");
    expect(INDEX_TS).toContain("UPDATE scm.mv_ar_aging_meta SET refreshed_at = now()");
  });
});
