import { describe, it, expect } from "vitest";
import {
  docTitle,
  FETCH_KINDS,
  fetchKind,
  myToday,
  parseFetchId,
  pctChange,
  pickFields,
  PROMPTS,
  promptText,
  resolveWindow,
  rm,
  searchResults,
  shiftMonths,
  singleMonth,
  summariseDelivery,
  summariseSales,
} from "./mcp-quick";
import { recallVerified, rememberVerified, VERIFIED_TTL_MS } from "./mcp-inner";
import { MAX_RESULT_CHARS, MCP_INSTRUCTIONS, MCP_TOOLS } from "../routes/mcp";

describe("AI Connector quick answers", () => {
  it("money and percent helpers", () => {
    expect(rm(56394474)).toBe(563944.74);
    expect(rm(null)).toBe(0);
    expect(pctChange(110, 100)).toBe(10);
    expect(pctChange(5, 0)).toBeNull();
  });

  it("windows end today and compare with the same days one period earlier", () => {
    expect(myToday(new Date("2026-11-25T17:00:00Z"))).toBe("2026-11-26"); // Malaysia is UTC+8
    expect(shiftMonths("2026-03-31", 1)).toBe("2026-02-28");
    expect(shiftMonths("2026-01-10", 1)).toBe("2025-12-10");
    expect(shiftMonths("2026-11-25", 12)).toBe("2025-11-25");
    const today = "2026-11-25";
    expect(resolveWindow({}, today)).toEqual({ from: "2026-11-01", to: "2026-11-25", label: "2026-11", months: 1, prev: { from: "2026-10-01", to: "2026-10-25" } });
    expect(resolveWindow({ period: "2026-10" }, today)?.to).toBe("2026-10-31");
    expect(resolveWindow({ period: "2026-q4" }, today)).toEqual({ from: "2026-10-01", to: "2026-11-25", label: "2026-Q4", months: 3, prev: { from: "2026-07-01", to: "2026-08-25" } });
    expect(resolveWindow({ period: "2025" }, today)?.prev).toEqual({ from: "2024-01-01", to: "2024-12-31" });
    expect(resolveWindow({ from: "2026-11-03", to: "2026-11-09" }, today)?.prev).toEqual({ from: "2026-10-03", to: "2026-10-09" });
    expect(resolveWindow({ period: "2027-01" }, today)).toBeNull(); // the future
    expect(resolveWindow({ period: "2026-13" }, today)).toBeNull();
    expect(resolveWindow({ period: "junk" }, today)).toBeNull();
    expect(resolveWindow({ from: "2026-11-09", to: "2026-11-01" }, today)).toBeNull();
    expect(resolveWindow({ from: "2026-11-01" }, today)).toBeNull();
    expect(singleMonth({ from: "2026-11-01", to: "2026-11-25" })).toBe("2026-11");
    expect(singleMonth({ from: "2026-10-01", to: "2026-11-25" })).toBeNull();
  });

  it("sales summary groups the Sales Report rows into a small answer", () => {
    const w = resolveWindow({}, "2026-11-25")!;
    const row = (venue: string | null, branding: string, salesperson: string, so_date: string, amount_sen: number) => ({ venue, branding, salesperson, state: "Selangor", so_date, amount_sen, cost_by_category: { bedframe_cost_sen: 1 } });
    const cur = {
      stage: "so",
      rows: [row("Mid Valley", "SEALY", "Ali", "2026-11-02", 300000), row("Mid Valley", "KING KOIL", "Bee", "2026-11-02", 100000), row(null, "SEALY", "Ali", "2026-11-03", 50000)],
      summary: { orders: 3, total_amount_sen: 450000, total_selling_sen: 440000, total_service_rev_sen: 10000, total_balance_sen: 120000, below_deposit_count: 1, margin_pct: 41.2, tender_totals: { Cash: 1000, Merchant: 2000, Installment: 0, Online: 500 } },
    };
    const prev = { summary: { orders: 2, total_amount_sen: 400000 } };
    const analysis = { monthly: [{ month: "2026-09", orders: 9, revenueSen: 100 }, { month: "2026-10", orders: 10, revenueSen: 200 }, { month: "2026-11", orders: 3, revenueSen: 450000 }], products: { byCategory: { BEDFRAME: [{ modelName: "Jager", category: "BEDFRAME", units: 4, revenueSen: 80000 }], MATTRESS: [{ modelName: "Posture", category: "MATTRESS", units: 2, revenueSen: 200000 }] } } };
    const s = summariseSales(w, cur, prev, analysis, "2026-11");
    expect(s.salesRm).toBe(4500);
    expect(s.previousPeriod).toEqual({ from: "2026-10-01", to: "2026-10-25", orders: 2, salesRm: 4000, changePct: 12.5 });
    expect(s.byShowroom).toEqual([{ name: "Mid Valley", orders: 2, salesRm: 4000 }, { name: "(no showroom)", orders: 1, salesRm: 500 }]);
    expect(s.bySalesperson[0]).toEqual({ name: "Ali", orders: 2, salesRm: 3500 });
    expect(s.daily).toEqual([{ date: "2026-11-02", orders: 2, salesRm: 4000 }, { date: "2026-11-03", orders: 1, salesRm: 500 }]);
    expect(s.topModels?.[0]).toEqual({ model: "Posture", category: "MATTRESS", units: 2, salesRm: 2000 });
    expect(s.trend?.map((t) => t.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(s.goodsMarginPct).toBe(41.2);
    expect(JSON.stringify(s)).not.toContain("cost"); // per-order cost never copied into the answer
  });

  it("sales summary leaves out what the reads did not give", () => {
    const w = resolveWindow({}, "2026-11-25")!;
    const s = summariseSales(w, { rows: [], summary: { orders: 0, total_amount_sen: 0, margin_pct: null } }, null, null, null);
    expect(s.previousPeriod).toBeNull();
    expect("goodsMarginPct" in s).toBe(false);
    expect("topModels" in s).toBe(false);
    expect("trend" in s).toBe(false);
  });

  it("delivery summary reads the Logistic Overview", () => {
    const w = resolveWindow({}, "2026-11-25")!;
    const cur = {
      period: { doCount: 40, doAmountSen: 8000000, podClosed: 31, byRegion: [{ region: "KL / Selangor", orders: 30, amountSen: 6000000 }], byLorry: [{ lorry: "VBA 1", orders: 12, amountSen: 2500000, occupancyPct: 80 }, { lorry: "VBA 2", orders: 0, amountSen: 0, occupancyPct: 0 }], days: [{ date: "2026-11-01", orders: 0, amountSen: 0 }, { date: "2026-11-02", orders: 5, amountSen: 900000 }], doList: [{ id: "x" }] },
      doNotClosed: { count: 3, amountSen: 150000 },
      doNoCost: { count: 1, amountSen: 1000 },
      soNoProcessing: { count: 2, oldestDays: 45 },
      deliveredOwing: { count: 4, balanceSen: 200000, oldestDays: 60 },
      deliveredOwingOver30: { count: 2, balanceSen: 100000 },
      months: [{ month: "2026-10", doCount: 50, doAmountSen: 9000000 }],
    };
    const d = summariseDelivery(w, cur, { period: { doCount: 32, doAmountSen: 6400000 } });
    expect(d.amountRm).toBe(80000);
    expect(d.previousPeriod?.changePct).toBe(25);
    expect(d.topLorries).toEqual([{ lorry: "VBA 1", orders: 12, amountRm: 25000, occupancyPct: 80 }]);
    expect(d.daily).toEqual([{ date: "2026-11-02", orders: 5, amountRm: 9000 }]);
    expect(d.gaps.deliveredStillOwing).toEqual({ count: 4, balanceRm: 2000, oldestDays: 60 });
    expect(JSON.stringify(d)).not.toContain("doList");
  });

  it("pickFields keeps only the named keys, at any depth", () => {
    const v = { success: true, data: { rows: [{ doc_no: "SO-1", status: "CONFIRMED", junk: 1 }] } };
    expect(pickFields(v, ["doc_no", "status"])).toEqual({ data: { rows: [{ doc_no: "SO-1", status: "CONFIRMED" }] } });
    expect(pickFields(v, [])).toBe(v);
  });

  it("search results in the shape ChatGPT requires, and fetch ids round-trip", () => {
    const body = { q: "013402", hits: [{ type: "sales_order", id: "HC-SO-013402", title: "HC-SO-013402", subtitle: "Tan · Mid Valley", status: "CONFIRMED", link: "/scm/sales-orders/HC-SO-013402" }, { type: "receipt", id: 7, title: "OR-1", link: "/scm/receipts/sundry/7" }, { type: "", id: 1 }], degraded: [] };
    const r = searchResults(body, "https://erp.example.com", 20);
    expect(r[0]).toEqual({ id: "sales_order:HC-SO-013402", title: "Sales order: HC-SO-013402", url: "https://erp.example.com/scm/sales-orders/HC-SO-013402", text: "Tan · Mid Valley · CONFIRMED" });
    expect(r).toHaveLength(2);
    expect(searchResults(body, "https://x", 1)).toHaveLength(1);
    expect(parseFetchId(r[0].id)).toEqual({ kind: "sales_order", rowId: "HC-SO-013402" });
    expect(parseFetchId("../etc")).toBeNull();
    expect(parseFetchId("sales_order:a/b")).toBeNull();
    expect(FETCH_KINDS.sales_order.api("HC-SO-1")).toBe("/api/scm/mfg-sales-orders/HC-SO-1");
    expect(fetchKind("receipt")).toBeNull(); // two receipt tables share one hit type: no single record to open
    expect(fetchKind("__proto__")).toBeNull();
    expect(fetchKind("constructor")).toBeNull();
    expect(fetchKind("delivery_order")?.page("abc")).toBe("/scm/delivery-orders/abc");
    expect(docTitle("sales_order", "x", { data: { doc_no: "HC-SO-1" } })).toBe("Sales order HC-SO-1");
    expect(docTitle("grn", "abc", { lines: [] })).toBe("Grn abc");
  });

  it("prompts expand to a question; an unknown prompt is refused", () => {
    expect(PROMPTS.map((p) => p.name)).toEqual(["monthly_sales_review", "delivery_review", "find_document"]);
    expect(promptText("monthly_sales_review", { period: "2026-10" })).toMatch(/2026-10.*sales_summary/);
    expect(promptText("find_document", { number: "HC-SO-013402" })).toMatch(/HC-SO-013402/);
    expect(promptText("nope", {})).toBeNull();
  });

  it("a verified token is reused for a few seconds, then forgotten", () => {
    rememberVerified("hzmcp_x", { userId: 1 }, 1_000);
    expect(recallVerified("hzmcp_x", 1_000 + VERIFIED_TTL_MS - 1)).toEqual({ userId: 1 });
    expect(recallVerified("hzmcp_x", 1_000 + VERIFIED_TTL_MS)).toBeNull();
    expect(recallVerified("hzmcp_never", 1_000)).toBeNull();
  });

  it("the tool list: quick answers first, every tool read-only, the instructions point at them", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(["sales_summary", "delivery_summary", "search", "fetch", "whoami", "list_modules", "list_endpoints", "erp_get"]);
    for (const t of MCP_TOOLS) expect(t.annotations.readOnlyHint).toBe(true);
    for (const name of ["sales_summary", "delivery_summary", "search", "fetch"]) expect(MCP_INSTRUCTIONS).toContain(name);
    expect(MAX_RESULT_CHARS).toBe(30_000);
  });
});
