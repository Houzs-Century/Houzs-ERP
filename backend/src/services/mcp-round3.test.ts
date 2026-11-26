import { describe, it, expect } from "vitest";
import { buildXlsx, colName, crc32, flattenRow, moneyHeader, pickColumns, sheetXml, xmlText } from "./mcp-xlsx";
import { answerCacheKey, cachedAnswer, DAILY_LIMIT_REACHED, rateDecision, RATE_PER_DAY, RATE_PER_MINUTE, stableArgs, TOO_MANY_PER_MINUTE, TtlCache } from "./mcp-ratelimit";
import { daysBetween, pickPosEvents, summariseAfterSales, summariseAttendance, summariseOutletSales, summarisePosEvent } from "./mcp-quick2";
import { addDays, briefApprovals, briefPurchaseOrders, briefSalesOrders, buildBrief, poDueDate } from "./mcp-brief";
import { EXPORT_LISTS, EXPORT_MAX_ROWS, exportQuery, fetchAllRows, isRound3Tool, matchesSearch, ROUND3_TOOLS, runRound3Tool, type R3Ctx, type R3Read } from "./mcp-round3";

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function unzip(buf: Uint8Array): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const crc = dv.getUint32(p + 14, true);
    const csize = dv.getUint32(p + 18, true);
    const nlen = dv.getUint16(p + 26, true);
    const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + nlen));
    // eslint-disable-next-line no-await-in-loop -- six small parts, read in order
    const data = await inflateRaw(buf.subarray(p + 30 + nlen, p + 30 + nlen + csize));
    expect(crc32(data)).toBe(crc);
    out[name] = new TextDecoder().decode(data);
    p += 30 + nlen + csize;
  }
  return out;
}

const ok = (value: unknown): R3Read => ({ ok: true, status: 200, value, removed: [], target: "" });
const denied: R3Read = { ok: false, status: 403, message: "Not available to your role", note: "no permission", target: "" };

function fakeCtx(routes: Partial<Record<string, (q: Record<string, unknown> | undefined) => R3Read>>, delayMs = 0) {
  const calls: { path: string; q: Record<string, unknown> | undefined }[] = [];
  const puts: { key: string; size: number }[] = [];
  const ctx: R3Ctx = {
    read: async (path, q) => {
      calls.push({ path, q });
      // eslint-disable-next-line houzs/no-imperative-timers -- a fake slow read: the test times it to prove the reads run in parallel
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const h = routes[path];
      return h ? h(q) : { ok: false, status: 404, message: "not found", note: "", target: path };
    },
    origin: "https://erp.example.test",
    userId: 7,
    bucket: { put: async (key: string, v: Uint8Array) => void puts.push({ key, size: v.length }) } as unknown as R3Ctx["bucket"],
    now: Date.parse("2026-11-26T04:00:00Z"),
  };
  return { ctx, calls, puts };
}
const body = (o: { result: { content: { text: string }[] } }) => JSON.parse(o.result.content[0].text) as Record<string, unknown>;

describe("xlsx writer", () => {
  it("flattens rows, names money columns in RM and honours fields", () => {
    expect(flattenRow({ doc_no: "SO-1", total_sen: 12345, supplier: { name: "Acme", nested: { x: 1 } }, items: [{ a: 1 }] })).toEqual({ doc_no: "SO-1", total_sen: 12345, "supplier.name": "Acme" });
    expect(moneyHeader("amountSen")).toBe("amount (RM)");
    const rows = [{ doc_no: "A", total_sen: 100, "supplier.name": "X" }, { doc_no: "B", status: "OPEN" }];
    expect(pickColumns(rows, []).map((c) => c.header)).toEqual(["doc_no", "total (RM)", "supplier.name", "status"]);
    expect(pickColumns(rows, ["doc_no", "supplier"]).map((c) => c.key)).toEqual(["doc_no", "supplier.name"]);
    expect(colName(0)).toBe("A");
    expect(colName(26)).toBe("AA");
    expect(xmlText('a<b>&"\u0001')).toBe("a&lt;b&gt;&amp;&quot;");
  });

  it("builds a valid zip with the workbook parts, money in RM", async () => {
    const rows = [{ doc_no: "HC-SO-1", total_sen: 123456, note: "x & y" }, { doc_no: "HC-SO-2", total_sen: 5 }];
    const cols = pickColumns(rows, []);
    const bytes = await buildXlsx("Sales orders", cols, rows);
    const files = await unzip(bytes);
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain("<v>1234.56</v>");
    expect(sheet).toContain("<v>0.05</v>");
    expect(sheet).toContain("x &amp; y");
    expect(sheet).toContain('t="inlineStr" s="1"><is><t>total (RM)</t>');
    expect(files["xl/workbook.xml"]).toContain('name="Sales orders"');
  });

  it("5,000 rows stay small and fast", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ doc_no: `HC-SO-${i}`, debtor_name: `Customer ${i}`, total_sen: i * 101, status: "CONFIRMED", so_date: "2026-11-01" }));
    const t0 = performance.now();
    const bytes = await buildXlsx("Sales orders", pickColumns(rows, []), rows);
    const ms = performance.now() - t0;
    expect(bytes.length).toBeLessThan(400_000);
    expect(ms).toBeLessThan(3000);
    expect(sheetXml(pickColumns(rows.slice(0, 1), []), rows.slice(0, 1))).toContain('<pane ySplit="1"');
  });
});

describe("rate limit and answer cache", () => {
  it("refuses at 30 a minute and 600 a day, daily first", () => {
    expect(rateDecision({ minute: RATE_PER_MINUTE - 1, day: 10 })).toBeNull();
    expect(rateDecision({ minute: RATE_PER_MINUTE, day: 10 })).toBe(TOO_MANY_PER_MINUTE);
    expect(rateDecision({ minute: 0, day: RATE_PER_DAY })).toBe(DAILY_LIMIT_REACHED);
    expect(rateDecision({ minute: 99, day: RATE_PER_DAY })).toBe(DAILY_LIMIT_REACHED);
  });

  it("cache keys separate people and companies, and ignore argument order", () => {
    expect(stableArgs({ b: 1, a: 2 })).toBe(stableArgs({ a: 2, b: 1 }));
    expect(answerCacheKey(1, null, "outlet_sales", {})).not.toBe(answerCacheKey(2, null, "outlet_sales", {}));
    expect(answerCacheKey(1, "A", "outlet_sales", {})).not.toBe(answerCacheKey(1, "B", "outlet_sales", {}));
    const c = new TtlCache<number>(1000, 2);
    c.set("a", 1, 0);
    expect(c.get("a", 999)).toBe(1);
    expect(c.get("a", 1000)).toBeUndefined();
    c.set("x", 1, 0);
    c.set("y", 2, 0);
    c.set("z", 3, 0);
    expect(c.size).toBe(2);
  });

  it("a repeat within 30 s is served from cache; errors are not kept", async () => {
    let n = 0;
    const make = async () => ({ result: { content: [], ...(n++ === 0 ? { isError: true } : {}) }, status: 200 });
    const key = `test|${Math.random()}`;
    await cachedAnswer(key, 0, make);
    const second = await cachedAnswer(key, 1, make);
    expect("cached" in second).toBe(false);
    const third = await cachedAnswer(key, 2, make);
    expect("cached" in third).toBe(true);
    expect(n).toBe(2);
  });
});

describe("round-3 quick answers", () => {
  const today = "2026-11-26";

  it("outlet_sales splits today and month-to-date by showroom", () => {
    const s = summariseOutletSales({ rows: [{ venue: "PJ", so_date: "2026-11-26", amount_sen: 10000 }, { venue: "PJ", so_date: "2026-11-02", amount_sen: 5000 }, { venue: "", so_date: "2026-11-26", amount_sen: 100 }] }, today);
    expect(s.totals).toEqual({ todayOrders: 2, todayRm: 101, mtdOrders: 3, mtdRm: 151 });
    expect(s.outlets[0]).toEqual({ outlet: "PJ", todayOrders: 1, todayRm: 100, mtdOrders: 2, mtdRm: 150 });
    expect(s.outlets[1].outlet).toBe("(no showroom)");
  });

  it("pos_sales picks on-going and this month's events and reads today from by_day", () => {
    const evs = pickPosEvents({ data: [{ project_id: 1, name: "Old", status: "DONE", end_date: "2026-10-30" }, { project_id: 2, name: "Now", status: "ON GOING", start_date: "2026-11-20" }, { project_id: 3, name: "Ended", status: "DONE", start_date: "2026-11-01", end_date: "2026-11-10" }] }, today);
    expect(evs.map((e) => e.name)).toEqual(["Now", "Ended"]);
    const e = summarisePosEvent(evs[0], { totals: { bills: 4, net_sen: 40000, by_day: [{ day: today, bills: 1, net_sen: 9900 }], by_method: [{ method: "QR", amount_sen: 40000 }], by_item: [] } }, today);
    expect(e).toMatchObject({ todayBills: 1, todayNetRm: 99, mtdBills: 4, mtdNetRm: 400 });
  });

  it("after_sales_summary buckets open cases by age", () => {
    expect(daysBetween("2026-11-20", today)).toBe(6);
    const s = summariseAfterSales(
      { active_count: 3, breach_count: 1 },
      [
        { id: 1, assr_no: "A1", stage: "pending_review", status: "Open", complained_date: "2026-11-25" },
        { id: 2, assr_no: "A2", stage: "pending_review", status: "Open", complained_date: "2026-10-01" },
        { id: 3, assr_no: "A3", stage: "qc", status: "In Progress", created_at: "2026-01-01T00:00:00Z", is_breached: 1 },
      ],
      3,
      today,
      "https://x",
    );
    expect(s.byAge.map((b) => b.cases)).toEqual([1, 0, 1, 1]);
    expect(s.byStage[0]).toEqual({ name: "pending_review", cases: 2 });
    expect(s.oldest[0]).toMatchObject({ case: "A3", breached: true, url: "https://x/assr?focus=3" });
  });

  it("attendance_today sorts people into leave, absent, late and no record", () => {
    const s = summariseAttendance({
      date: today,
      rows: [
        { employee: { name: "Ali", department: "Sales", status: "ACTIVE" }, day: { status: "ANNUAL_LEAVE" } },
        { employee: { name: "Bob", status: "ACTIVE" }, day: { status: "ABSENT" } },
        { employee: { name: "Cat", status: "ACTIVE" }, day: { status: "PRESENT", lateMin: 12 } },
        { employee: { name: "Dan", status: "ACTIVE" }, day: null },
        { employee: { name: "Eve", status: "RESIGNED" }, day: null },
      ],
    });
    expect(s).toMatchObject({ present: 1, onLeaveCount: 1, absentCount: 1, lateCount: 1, noRecordYetCount: 1 });
    expect(s.onLeave[0]).toEqual({ name: "Ali", department: "Sales", leave: "Annual leave" });
  });
});

describe("daily brief", () => {
  const today = "2026-11-26";
  const origin = "https://erp.example.test";

  it("keeps only due / overdue documents and non-zero counts", () => {
    expect(addDays(today, 3)).toBe("2026-11-29");
    expect(briefApprovals({ counts: { "mail-waiting": 2, "amendment-approvals": 0, "finance-todo": null } })).toEqual([{ title: "Mail Center threads waiting for you", count: 2 }]);
    const so = briefSalesOrders(
      { salesOrders: [{ doc_no: "S1", status: "CONFIRMED", customer_delivery_date: "2026-11-20" }, { doc_no: "S2", status: "DELIVERED", customer_delivery_date: "2026-11-20" }, { doc_no: "S3", status: "IN_PRODUCTION", customer_delivery_date: "2026-11-28" }, { doc_no: "S4", status: "CONFIRMED", customer_delivery_date: "2026-12-20" }] },
      today,
      origin,
    );
    expect(so.count).toBe(2);
    expect(so.overdue).toBe(1);
    expect(so.top[0]).toMatchObject({ doc: "S1", overdue: true, url: `${origin}/scm/sales-orders/S1` });
    expect(poDueDate({ expected_at: "2026-11-01", supplier_delivery_date_3: "2026-11-27" })).toBe("2026-11-27");
    expect(briefPurchaseOrders({ purchaseOrders: [{ id: "p1", po_number: "PO1", expected_at: "2026-11-01", supplier_delivery_date_2: "2026-12-30" }] }, today, origin).count).toBe(0);
  });

  it("says plainly what the person cannot see and carries on", () => {
    const b = buildBrief(
      { badges: { ok: true, value: { counts: {} } }, salesOrders: { ok: true, value: { salesOrders: [] } }, purchaseOrders: { ok: false, status: 403, message: "no" }, cases: { ok: true, value: { cases: [] } }, leave: { ok: true, value: { pending: [] } }, notices: { ok: true, value: { data: [{ id: "n1", title: "Hi" }], ackedIds: [] } } },
      today,
      origin,
    );
    expect(b.notAvailable).toEqual(["You don't have access to purchase orders."]);
    expect(b.sections.map((s) => s.title)).toEqual(["Announcements you have not acknowledged"]);
  });
});

describe("round-3 tools through a fake ERP", () => {
  it("are registered with schemas", () => {
    expect(ROUND3_TOOLS.map((t) => t.name)).toEqual(["outlet_sales", "pos_sales", "after_sales_summary", "attendance_today", "daily_brief", "export_excel", "po_overdue", "supplier_lateness", "payables_summary", "so_overdue", "deliveries_due", "receivables_summary"]);
    expect(isRound3Tool("daily_brief")).toBe(true);
    expect(isRound3Tool("erp_get")).toBe(false);
  });

  it("attendance_today for a non-HR person is a plain no-access answer", async () => {
    const { ctx } = fakeCtx({ "/api/hr/attendance": () => denied });
    const o = await runRound3Tool(ctx, "attendance_today", {});
    expect(o.result.isError).toBe(true);
    expect(o.result.content[0].text).toBe("You don't have access to HR attendance in the ERP.");
  });

  it("daily_brief makes six reads at once (latency = one read, not six)", async () => {
    const { ctx, calls } = fakeCtx(
      {
        "/api/badge-counts": () => ok({ counts: { "mail-waiting": 1 } }),
        "/api/scm/mfg-sales-orders/mine": () => ok({ salesOrders: [] }),
        "/api/scm/mfg-purchase-orders": () => denied,
        "/api/assr/my-cases": () => ok({ cases: [] }),
        "/api/attendance/leave": () => ok({ pending: [] }),
        "/api/announcements/banner": () => ok({ data: [], ackedIds: [] }),
      },
      40,
    );
    const t0 = performance.now();
    const o = await runRound3Tool(ctx, "daily_brief", {});
    const ms = performance.now() - t0;
    expect(calls).toHaveLength(6);
    expect(ms).toBeLessThan(40 * 3);
    const b = body(o);
    expect(b.waitingForYou).toEqual([{ title: "Mail Center threads waiting for you", count: 1 }]);
    expect(b.notAvailable).toEqual(["You don't have access to purchase orders."]);
    expect(calls[0].q).toMatchObject({ sources: expect.stringContaining("mail-waiting") });
  });

  it("pos_sales reads every picked event's report in parallel", async () => {
    const { ctx, calls } = fakeCtx(
      {
        "/api/pos-admin/events": () => ok({ data: [1, 2, 3].map((i) => ({ project_id: i, name: `E${i}`, status: "ON GOING", start_date: "2026-11-0" + i })) }),
        "/api/pos-admin/report": (q) => ok({ totals: { bills: 1, net_sen: Number(q?.project_id) * 100, by_day: [] } }),
      },
      30,
    );
    const t0 = performance.now();
    const b = body(await runRound3Tool(ctx, "pos_sales", {}));
    expect(performance.now() - t0).toBeLessThan(30 * 3.5);
    expect(calls).toHaveLength(4);
    expect((b.totals as { mtdNetRm: number }).mtdNetRm).toBe(6);
  });

  it("export_excel pages as the person, caps at 5,000 rows and stores a 15-minute file", async () => {
    let pagesRead = 0;
    const { ctx, puts } = fakeCtx({
      "/api/scm/mfg-sales-orders": (q) => {
        pagesRead += 1;
        const page = Number(q?.page);
        return ok({ total: 7000, salesOrders: Array.from({ length: 100 }, (_, i) => ({ doc_no: `S${page * 100 + i}`, total_sen: 100 })) });
      },
    });
    const o = await runRound3Tool(ctx, "export_excel", { list: "sales_orders", status: "CONFIRMED", fields: ["doc_no", "total_sen"] });
    const b = body(o);
    expect(pagesRead).toBe(EXPORT_MAX_ROWS / 100);
    expect(b).toMatchObject({ rows: EXPORT_MAX_ROWS, columns: 2, truncated: true });
    expect(String(b.download)).toMatch(/^https:\/\/erp\.example\.test\/api\/mcp\/xlsx\/[A-Za-z0-9_-]{40,64}$/);
    expect(puts[0].key).toMatch(/^mcp-exports\/.+\.xlsx$/);
    expect(o.note).toContain("truncated");
  });

  it("export_excel refuses unknown lists, bad dates and passes a 403 through", async () => {
    const { ctx } = fakeCtx({ "/api/scm/grns": () => denied });
    expect((await runRound3Tool(ctx, "export_excel", { list: "users" })).result.isError).toBe(true);
    expect(exportQuery(EXPORT_LISTS.sales_orders, { from: "26/11/2026" })).toEqual({ ok: false, message: "Dates are YYYY-MM-DD." });
    expect(exportQuery(EXPORT_LISTS.service_cases, { search: "abc" })).toEqual({ ok: true, q: { search: "abc" } });
    const g = await runRound3Tool(ctx, "export_excel", { list: "grns" });
    expect(g.result.content[0].text).toBe("You don't have access to goods received in the ERP.");
    expect(matchesSearch({ name: "Tan Ah Kow" }, "ah k")).toBe(true);
  });

  it("export_excel reads a whole-list endpoint once", async () => {
    const { ctx, calls } = fakeCtx({ "/api/scm/other-debtors": () => ok({ debtors: [{ name: "A", outstanding_sen: 100 }, { name: "B" }] }) });
    const got = await fetchAllRows(ctx, EXPORT_LISTS.customers, {});
    expect(got.ok && got.rows.length).toBe(2);
    expect(calls).toHaveLength(1);
  });
});
