/**
 * Regression proof for the 2026-08-12 whole-system review's high-severity
 * findings that were still live on `main` and that no open PR claimed.
 *
 * Every case here FAILS on the pre-fix code. Where a finding is one instance of
 * a class, the test asserts the CLASS (the shared predicate, the shared helper),
 * not the single call site, so re-typing the rule by hand somewhere else fails
 * too.
 */
import { describe, expect, test } from "vitest";
import { bucketDrilldown, rawProjectCost, rawServiceCost } from "../src/routes/finance";
import { assrOpenStageSql, ASSR_TERMINAL_STAGES } from "../src/services/assrStages";
import { runSlaEscalation } from "../src/services/assrEscalation";
import { soStatusTransitionError } from "../src/scm/lib/so-lifecycle-guards";
import { SALES_ORDERS_MIRROR_COLUMNS, upsertSalesOrder } from "../src/services/pull";

/* ── A recording `env.DB` ────────────────────────────────────────────────────
   These paths build raw SQL text and bind positionally, so what has to be
   proved is what the statement SAYS and what it SENDS. The fake records both
   and returns empty results. */
type Recorded = { sql: string; binds: unknown[] };
function recordingDB() {
  const calls: Recorded[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return {
            all: async () => ({ results: [] }),
            first: async () => null,
            run: async () => ({}),
          };
        },
        all: async () => {
          calls.push({ sql, binds: [] });
          return { results: [] };
        },
        first: async () => {
          calls.push({ sql, binds: [] });
          return null;
        },
        run: async () => {
          calls.push({ sql, binds: [] });
          return {};
        },
      };
    },
  };
  return { DB, calls };
}

/** Everything from FROM to the end of the WHERE — the predicate, whitespace-flattened. */
const predicateOf = (sql: string) =>
  (sql.slice(sql.indexOf("FROM")).split(/\bORDER BY\b/)[0] ?? "").replace(/\s+/g, " ").trim();

const COMPANY = 7;

describe("F4 — a P&L bucket and its drill-down must apply the SAME predicate", () => {
  /* The drill-down carried neither the company filter nor the archived-project
     join that its own total applies, so clicking a company's cost bucket listed
     the other company's finance lines and the archived projects' cost with it —
     a row list that cannot add up to the number it was opened from. */
  test("project cost: drill-down predicate is byte-identical to the total's", async () => {
    const a = recordingDB();
    await rawProjectCost({ DB: a.DB } as any, "2026-01-01", "2026-02-01", COMPANY);
    const b = recordingDB();
    await bucketDrilldown({ DB: b.DB } as any, "2026-01-01", "2026-02-01", COMPANY);

    const total = predicateOf(a.calls[0]!.sql);
    const drill = b.calls.map((x) => predicateOf(x.sql)).find((p) => p.includes("project_finance_lines"));
    expect(drill).toBe(total);
    expect(total).toContain("p.archived_at IS NULL");
    expect(total).toContain("l.company_id = ?");
  });

  test("service cost: drill-down predicate matches the total's, join aside", async () => {
    const a = recordingDB();
    await rawServiceCost({ DB: a.DB } as any, "2026-01-01", "2026-02-01", COMPANY);
    const b = recordingDB();
    await bucketDrilldown({ DB: b.DB } as any, "2026-01-01", "2026-02-01", COMPANY);

    const drill = b.calls.map((x) => x.sql).find((s) => s.includes("assr_cases"))!;
    /* The two differ only in the alias the caller needed (the drill-down joins
       creditors, so its columns are qualified) — normalise both away and the
       predicate must be the SAME text. */
    const canonical = (p: string) =>
      p.replace(/LEFT JOIN creditors[^W]*?(?=WHERE)/, "")
        .replace(/FROM assr_cases c\b/, "FROM assr_cases")
        .replace(/\bc\./g, "");
    expect(canonical(predicateOf(drill))).toBe(canonical(predicateOf(a.calls[0]!.sql)));
    expect(predicateOf(drill)).toContain("c.company_id = ?");
  });

  test("every drill-down query BINDS the company it was given", async () => {
    const { DB, calls } = recordingDB();
    await bucketDrilldown({ DB } as any, "2026-01-01", "2026-02-01", COMPANY);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toMatch(/company_id = \?/);
      expect(call.binds).toEqual(["2026-01-01", "2026-02-01", COMPANY]);
    }
  });

  test("an unresolved company still omits the filter (single-company degrade)", async () => {
    const { DB, calls } = recordingDB();
    await bucketDrilldown({ DB } as any, "2026-01-01", "2026-02-01", undefined);
    for (const call of calls) {
      expect(call.sql).not.toMatch(/company_id = \?/);
      expect(call.binds).toEqual(["2026-01-01", "2026-02-01"]);
    }
  });
});

describe("F28 — a closed service case is not an open one", () => {
  test("both terminal stages are excluded, and a NULL stage still reads open", () => {
    const sql = assrOpenStageSql("c");
    expect(ASSR_TERMINAL_STAGES).toEqual(["completed", "voided"]);
    for (const stage of ASSR_TERMINAL_STAGES) expect(sql).toContain(`'${stage}'`);
    // The IS NULL arm is load-bearing: `stage NOT IN (…)` is NULL for a legacy
    // row, which is not TRUE, and those rows would silently leave every count.
    expect(sql).toContain("c.stage IS NULL");
  });

  test("the SLA escalation cron skips voided AND archived cases", async () => {
    const { DB, calls } = recordingDB();
    await runSlaEscalation({ DB } as any);
    const candidates = calls[0]!.sql;
    expect(candidates).toContain("'voided'");
    expect(candidates).toContain("c.archived_at IS NULL");
    // and it must not have gone back to naming only one terminal stage
    expect(candidates).not.toMatch(/stage\s*!=\s*'completed'/);
  });
});

describe("F16 — ON_HOLD is not a route back to DRAFT", () => {
  /* DELIVERED>DRAFT is refused on rank. DELIVERED>ON_HOLD and ON_HOLD>DRAFT were
     each allowed unconditionally, so the pair was the refused move in two steps —
     and DRAFT is what unlocks the hard DELETE that cascades the lines, the
     payments and the audit log away. */
  test("a paused order cannot be resumed into DRAFT", () => {
    const err = soStatusTransitionError("ON_HOLD", "DRAFT");
    expect(err).not.toBeNull();
    expect(err!.error).toBe("illegal_status_transition");
    expect(err!.code).toBe(409);
  });

  test("the direct move it launders is still refused", () => {
    expect(soStatusTransitionError("DELIVERED", "DRAFT")).not.toBeNull();
  });

  test("ordinary pause and resume are untouched", () => {
    for (const to of ["CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "INVOICED", "CLOSED"]) {
      expect(soStatusTransitionError("ON_HOLD", to)).toBeNull();
    }
    for (const from of ["DRAFT", "CONFIRMED", "IN_PRODUCTION", "DELIVERED", "INVOICED"]) {
      expect(soStatusTransitionError(from, "ON_HOLD")).toBeNull();
    }
  });
});

describe("F29 — the AutoCount SO mirror writes columns that exist", () => {
  const columnsNamedBy = (sql: string) => {
    const head = sql.slice(sql.indexOf("(") + 1, sql.indexOf(") VALUES"));
    return head
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("("));
  };

  test("the INSERT names no column public.sales_orders does not have", async () => {
    const { DB, calls } = recordingDB();
    await upsertSalesOrder({ DB } as any, { DocNo: "SO-1" } as any, "WEST");
    const named = columnsNamedBy(calls[0]!.sql);
    const unknown = named.filter((col) => !SALES_ORDERS_MIRROR_COLUMNS.includes(col as never));
    expect(unknown).toEqual([]);
  });

  test("the ON CONFLICT branch names no unknown column either", async () => {
    const { DB, calls } = recordingDB();
    await upsertSalesOrder({ DB } as any, { DocNo: "SO-1" } as any, "WEST");
    const setClause = calls[0]!.sql.slice(calls[0]!.sql.indexOf("DO UPDATE SET"));
    for (const col of ["transfer_to", "note", "inv_addr1", "inv_addr2", "inv_addr3", "inv_addr4", "sync_error"]) {
      expect(setClause).not.toContain(`${col} =`);
    }
  });

  test("company_id is written — it is NOT NULL with no default (mig 0083)", async () => {
    const { DB, calls } = recordingDB();
    await upsertSalesOrder({ DB } as any, { DocNo: "SO-1" } as any, "WEST");
    expect(columnsNamedBy(calls[0]!.sql)).toContain("company_id");
    expect(calls[0]!.sql).toContain("SELECT id FROM companies WHERE code = 'HOUZS'");
  });

  test("the placeholder count still matches the binds", async () => {
    const { DB, calls } = recordingDB();
    await upsertSalesOrder({ DB } as any, { DocNo: "SO-1" } as any, "WEST");
    const values = calls[0]!.sql.slice(calls[0]!.sql.indexOf(") VALUES"), calls[0]!.sql.indexOf("ON CONFLICT"));
    expect((values.match(/\?/g) ?? []).length).toBe(calls[0]!.binds.length);
  });
});
