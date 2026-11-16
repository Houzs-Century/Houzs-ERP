// @vitest-project light
/**
 * The auto commission / transport / merchandise lines are worked on a fair's
 * sales — its typed sales lines AND the bills keyed as sales entries, as the
 * event P&L (eventPnlBatch.ts) and the Total Sales rollup (syncFinanceRollup)
 * count them.
 *
 * Symptom (2026-11-16): 8 June 2026 fairs carried their sales twice — 31 bills
 * (project 70, RM 250,535) and one typed "sales (FAIR PNL v8 align)" line of the
 * same amount — so the Project Overview read RM 501,070. Archiving the typed
 * line is the repair; but this engine read the typed lines alone, so the next
 * ledger edit on such a fair saw no sales and DELETED its auto cost lines,
 * taking them out of Finance's P&L. Fails on the pre-fix code.
 */
import { describe, expect, test } from "vitest";
import { recomputeAutoCostLines } from "../src/services/projectCostRates";
import type { Env } from "../src/types";

type Call = { sql: string; binds: unknown[] };

/** A D1 stand-in answering the engine's reads from the given figures and recording its writes. */
function fairDB(figures: { typedSales: number; billSales: number; cogs?: number; autoIds?: Record<string, number> }) {
  const calls: Call[] = [];
  const answer = (sql: string): unknown => {
    if (/FROM projects WHERE id/.test(sql)) return { brand: "AKEMI", archived_at: null };
    if (/FROM project_cost_rates/.test(sql)) {
      return { transport_pct: 4, merchandise_pct: 2, commission_normal_pct: 14, commission_boost_pct: null, boost_min_gp_pct: null, boost_min_sales: null };
    }
    if (/FROM sales_entries/.test(sql)) return { sales: figures.billSales };
    if (/FROM project_finance_lines/.test(sql) && /auto_source IS NULL/.test(sql)) return { sales: figures.typedSales, cogs: figures.cogs ?? 0 };
    return null;
  };
  const autoRows = Object.entries(figures.autoIds ?? {}).map(([auto_source, id]) => ({ id, auto_source }));
  const DB = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return {
            first: async () => answer(sql),
            all: async () => ({ results: /auto_source IS NOT NULL/.test(sql) && /^\s*SELECT/i.test(sql) ? autoRows : [] }),
            run: async () => ({}),
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql));

describe("auto cost lines on a fair's sales", () => {
  test("a fair whose sales are only its bills keeps its auto lines, worked on the bills", async () => {
    const { env, calls } = fairDB({ typedSales: 0, billSales: 250_535, autoIds: { "auto:transport": 11, "auto:merchandise": 12, "auto:commission": 13 } });
    await recomputeAutoCostLines(env, 70, 0);
    const w = writes(calls);
    expect(w.some((c) => /^\s*DELETE/i.test(c.sql))).toBe(false);
    const amountOf = (id: number) => w.find((c) => /^\s*UPDATE/i.test(c.sql) && c.binds.at(-1) === id)?.binds[0];
    expect(amountOf(11)).toBe(10_021.4);
    expect(amountOf(12)).toBe(5_010.7);
    expect(amountOf(13)).toBe(35_074.9);
  });

  test("typed sales and bills are added together, as the event P&L adds them", async () => {
    const { env, calls } = fairDB({ typedSales: 1_000, billSales: 500, autoIds: { "auto:transport": 21, "auto:merchandise": 22, "auto:commission": 23 } });
    await recomputeAutoCostLines(env, 7, 0);
    const update = writes(calls).find((c) => /^\s*UPDATE/i.test(c.sql) && c.binds.at(-1) === 23);
    expect(update?.binds[0]).toBe(210);
  });

  test("no sales at all still clears the auto lines", async () => {
    const { env, calls } = fairDB({ typedSales: 0, billSales: 0 });
    await recomputeAutoCostLines(env, 9, 0);
    expect(writes(calls).map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(["DELETE"]);
  });
});
