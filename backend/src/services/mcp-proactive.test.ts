import { describe, expect, it } from "vitest";
import { redactMoney } from "./mcp-access";
import { buildDataGaps, gapCustomersNoPhone, gapProducts, gapSoNoDeliveryDate, gapUnappliedPayments } from "./mcp-data-gaps";
import {
  ALERT_THRESHOLDS,
  alertEmail,
  briefDue,
  briefEmail,
  debounceSince,
  DEFAULT_PREFS,
  escapeHtml,
  freshAlerts,
  isMondayMyt,
  mytClock,
  parseBriefPrefs,
  poAlerts,
  rowLine,
  slaAlerts,
  soAlerts,
  stockAlerts,
  type Alert,
} from "./mcp-proactive";
import { runRound3Tool, type R3Ctx, type R3Read } from "./mcp-round3";

const origin = "https://erp.example.test";
const today = "2026-11-27";
const at = (iso: string): number => Date.parse(iso);

describe("opt-in: parseBriefPrefs", () => {
  it("takes a quarter-hour MYT time, weekdays / daily and two switches; keeps what is not sent", () => {
    const r = parseBriefPrefs({ briefEnabled: true, time: "07:45", days: "daily" }, DEFAULT_PREFS);
    expect(r).toEqual({ ok: true, prefs: { briefEnabled: true, time: "07:45", days: "daily", alertsEnabled: false } });
    expect(parseBriefPrefs({ alertsEnabled: true }, { ...DEFAULT_PREFS, time: "09:00" })).toEqual({ ok: true, prefs: { ...DEFAULT_PREFS, time: "09:00", alertsEnabled: true } });
  });

  it("refuses a time off the quarter hour, a bad day rule and non-boolean switches", () => {
    for (const bad of [{ time: "08:10" }, { time: "24:00" }, { time: "8:00" }, { days: "weekends" }, { briefEnabled: "yes" }, { alertsEnabled: 1 }]) {
      expect(parseBriefPrefs(bad, DEFAULT_PREFS).ok).toBe(false);
    }
  });

  it("defaults to 08:00 MYT, weekdays, both off", () => {
    expect(DEFAULT_PREFS).toEqual({ briefEnabled: false, time: "08:00", days: "weekdays", alertsEnabled: false });
  });
});

describe("schedule: briefDue", () => {
  const sub = (o: Partial<typeof DEFAULT_PREFS> = {}, last: string | null = null) => ({ prefs: { ...DEFAULT_PREFS, briefEnabled: true, ...o }, lastBriefDay: last });

  it("reads Malaysia time (UTC+8)", () => {
    expect(mytClock(at("2026-11-27T00:00:00Z"))).toEqual({ day: "2026-11-27", minutes: 480, weekday: 5 });
    expect(mytClock(at("2026-11-26T16:30:00Z")).day).toBe("2026-11-27");
    expect(isMondayMyt(at("2026-11-30T00:00:00Z"))).toBe(true);
    expect(isMondayMyt(at("2026-11-29T15:59:00Z"))).toBe(false);
  });

  it("is due at or after the time, once a day, within the catch-up window", () => {
    expect(briefDue(sub(), at("2026-11-26T23:59:00Z"))).toBe(false);
    expect(briefDue(sub(), at("2026-11-27T00:00:00Z"))).toBe(true);
    expect(briefDue(sub(), at("2026-11-27T02:59:00Z"))).toBe(true);
    expect(briefDue(sub(), at("2026-11-27T03:00:00Z"))).toBe(false);
    expect(briefDue(sub({}, "2026-11-27"), at("2026-11-27T00:15:00Z"))).toBe(false);
    expect(briefDue(sub({}, "2026-11-26"), at("2026-11-27T00:15:00Z"))).toBe(true);
  });

  it("skips weekends on 'weekdays', sends on 'daily', never when off", () => {
    const sat = at("2026-11-28T00:30:00Z");
    expect(briefDue(sub(), sat)).toBe(false);
    expect(briefDue(sub({ days: "daily" }), sat)).toBe(true);
    expect(briefDue({ prefs: DEFAULT_PREFS, lastBriefDay: null }, at("2026-11-27T00:30:00Z"))).toBe(false);
  });
});

const BRIEF = {
  today,
  waitingForYou: [{ title: "Purchase order amendments to approve", count: 2 }],
  sections: [
    {
      title: "Your sales orders due for delivery (past or within 3 days)",
      count: 7,
      overdue: 1,
      top: [
        { doc: "SO-1", customer: "Tan <script>", deliveryDate: "2026-11-25", overdue: true, status: "CONFIRMED", url: `${origin}/scm/sales-orders/SO-1` },
        { doc: "SO-2", customer: "Lim", deliveryDate: "2026-11-28", overdue: false, status: "CONFIRMED", url: "https://evil.example/x" },
      ],
    },
  ],
  notAvailable: ["You don't have access to service cases."],
};

describe("brief email: briefEmail", () => {
  const base = { name: "Lee Wei", today, origin, unsubscribeUrl: `${origin}/api/mcp/brief/unsubscribe/tok`, settingsUrl: `${origin}/ai-connector` };

  it("shows counts, the first lines with ERP links, what is hidden, and the unsubscribe link", () => {
    const m = briefEmail({ ...base, brief: BRIEF, gaps: null });
    expect(m.items).toBe(9);
    expect(m.subject).toBe("Your ERP brief, 2026/11/27: 9 to look at");
    expect(m.html).toContain("Good morning, Lee");
    expect(m.html).toContain("Purchase order amendments to approve: <strong>2</strong>");
    expect(m.html).toContain(`href="${origin}/scm/sales-orders/SO-1"`);
    expect(m.html).toContain("and 5 more");
    expect(m.html).toContain("overdue</span>");
    expect(m.html).toContain("You don&#39;t have access to service cases.");
    expect(m.html).toContain(`href="${origin}/api/mcp/brief/unsubscribe/tok"`);
    expect(m.html).not.toContain("Data gaps (every Monday)");
  });

  it("escapes ERP text and never links outside the ERP", () => {
    const m = briefEmail({ ...base, brief: BRIEF, gaps: null });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("Tan &lt;script&gt;");
    expect(m.html).not.toContain("evil.example");
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });

  it("says all clear when nothing is waiting", () => {
    const m = briefEmail({ ...base, brief: { today, waitingForYou: [], sections: [] }, gaps: null });
    expect(m.items).toBe(0);
    expect(m.subject).toContain("all clear");
    expect(m.html).toContain("Nothing due, overdue or waiting for you right now.");
  });

  it("appends the Monday data gaps with values and links", () => {
    const gaps = {
      gaps: [{ title: "Supplier payments not matched to a bill", count: 12, valueRm: 4600000, note: "Match them.", top: [{ supplier: "Acme", unappliedRm: 1200.5, documents: 3 }], url: `${origin}/scm/accounting?tab=ap` }],
      clean: [],
      notAvailable: ["You don't have access to customers."],
    };
    const m = briefEmail({ ...base, brief: BRIEF, gaps });
    expect(m.html).toContain("Data gaps (every Monday)");
    expect(m.html).toContain("RM 4,600,000.00");
    expect(m.html).toContain("RM 1,200.50");
    expect(m.html).toContain("You don&#39;t have access to customers.");
  });

  it("rowLine renders the label first, then the facts", () => {
    expect(rowLine({ po: "PO-9", supplier: "Acme", valueRm: 10, url: `${origin}/scm/purchase-orders/1` }, origin)).toBe(
      `<a href="${origin}/scm/purchase-orders/1" style="color:#1d4ed8;text-decoration:none;font-weight:600">PO-9</a> &middot; Acme &middot; RM 10.00`,
    );
  });
});

describe("alerts: what counts as urgent", () => {
  const t = ALERT_THRESHOLDS;

  it("SO: newly overdue (1-2 days) and worth the threshold; held or old ones are left out", () => {
    const rows = [
      { doc_no: "SO-A", debtor_name: "A", customer_delivery_date: "2026-11-26", local_total_sen: 600000 },
      { doc_no: "SO-B", debtor_name: "B", customer_delivery_date: "2026-11-26", local_total_sen: 100000 },
      { doc_no: "SO-C", debtor_name: "C", customer_delivery_date: "2026-11-20", local_total_sen: 900000 },
      { doc_no: "SO-D", debtor_name: "D", customer_delivery_date: "2026-11-27", local_total_sen: 900000 },
      { doc_no: "SO-E", debtor_name: "E", customer_delivery_date: "2026-11-25", local_total_sen: 900000, on_hold: true },
    ];
    const a = soAlerts(rows, today, origin, t);
    expect(a.map((x) => x.key)).toEqual(["so_overdue:SO-A:2026-11-26"]);
    expect(a[0].url).toBe(`${origin}/scm/sales-orders/SO-A`);
  });

  it("SO: a value stripped from the person's reply is never above the threshold", () => {
    const rows = [{ doc_no: "SO-A", customer_delivery_date: "2026-11-26" }];
    expect(soAlerts(rows, today, origin, t)).toEqual([]);
  });

  it("PO: the latest supplier date decides; key carries that date", () => {
    const rows = [
      { id: "p1", po_number: "PO-1", total_sen: 800000, expected_at: "2026-11-10", supplier_delivery_date_2: "2026-11-25", supplier: { name: "Acme" } },
      { id: "p2", po_number: "PO-2", total_sen: 800000, expected_at: "2026-11-26", supplier_delivery_date_2: "2026-12-05" },
    ];
    expect(poAlerts(rows, today, origin, t).map((x) => x.key)).toEqual(["po_overdue:p1:2026-11-25"]);
  });

  it("SLA: only cases whose deadline passed within the window", () => {
    const now = at("2026-11-27T04:00:00Z");
    const drill = { cases: [{ id: 1, assr_no: "AS-1", deadline_at: "2026-11-27T01:00:00Z" }, { id: 2, assr_no: "AS-2", deadline_at: "2026-11-25T01:00:00Z" }, { id: 3, deadline_at: "2026-11-28T01:00:00Z" }] };
    expect(slaAlerts(drill, now, origin, t).map((x) => x.label)).toEqual(["AS-1"]);
  });

  it("stock: items below zero", () => {
    expect(stockAlerts({ products: [{ item_code: "X1", total_qty: -2 }, { item_code: "X2", total_qty: 0 }] }, origin).map((x) => x.key)).toEqual(["stock_negative:X1"]);
  });
});

describe("alerts: debounce", () => {
  const t = ALERT_THRESHOLDS;
  const a = (key: string): Alert => ({ key, kind: "so_overdue", label: key, detail: "", url: `${origin}/x` });

  it("drops keys already emailed in the window and duplicates in one run", () => {
    const out = freshAlerts([a("k1"), a("k2"), a("k2"), a("k3")], new Set(["k1"]), t);
    expect(out.map((x) => x.key)).toEqual(["k2", "k3"]);
  });

  it("caps one email at maxLinesPerEmail", () => {
    const many = Array.from({ length: 40 }, (_, i) => a(`k${i}`));
    expect(freshAlerts(many, new Set(), t)).toHaveLength(t.maxLinesPerEmail);
  });

  it("the window covers today and the days before it (so never twice a day)", () => {
    expect(debounceSince(today, t)).toBe("2026-11-21");
    expect(debounceSince(today, { ...t, repeatAfterDays: 1 })).toBe(today);
  });

  it("alert email groups by kind with links", () => {
    const m = alertEmail({ name: "X", alerts: [a("k1"), { ...a("s1"), kind: "sla" }], origin, unsubscribeUrl: `${origin}/u`, settingsUrl: `${origin}/s` });
    expect(m.subject).toBe("ERP alert: 2 items need attention");
    expect(m.html).toContain("Sales orders that just became overdue");
    expect(m.html).toContain("Service cases that just passed their deadline");
  });
});

const ok = (value: unknown): R3Read => ({ ok: true, status: 200, value, removed: [], target: "" });
const denied: R3Read = { ok: false, status: 403, message: "Not available to your role", note: "no permission", target: "" };

describe("data_gaps", () => {
  it("unapplied supplier payments from the AP aging", () => {
    const s = gapUnappliedPayments({ totals: { unappliedSen: -460000000 }, rows: [{ name: "Acme", unappliedSen: -300000, unapplied: [{}, {}] }, { name: "Beta", unappliedSen: -900000, unapplied: [{}] }, { name: "Zero", unappliedSen: 0 }] }, origin);
    expect(s.valueRm).toBe(4600000);
    expect(s.count).toBe(3);
    expect(s.top[0]).toEqual({ supplier: "Beta", unappliedRm: 9000, documents: 1 });
  });

  it("open SOs with no delivery date, oldest first", () => {
    const s = gapSoNoDeliveryDate([{ doc_no: "S2", so_date: "2026-11-02" }, { doc_no: "S1", so_date: "2026-10-01", customer_delivery_date: null }, { doc_no: "S3", customer_delivery_date: "2026-12-01" }], origin, false);
    expect(s.count).toBe(2);
    expect(s.top.map((x) => x.so)).toEqual(["S1", "S2"]);
  });

  it("products with no cost / no price / no category (service items left out)", () => {
    const p = gapProducts(
      {
        products: [
          { code: "A", category: "SOFA", costAnchorState: "empty", sell_price_sen: 100 },
          { code: "B", category: "", costAnchorState: "anchored", price1_sen: 0, sell_price_sen: null, base_price_sen: 0 },
          { code: "S", category: "SERVICE", costAnchorState: "service" },
        ],
      },
      origin,
    );
    expect([p.noCost.count, p.noPrice.count, p.noCategory.count]).toEqual([1, 1, 1]);
  });

  it("customers with no phone", () => {
    expect(gapCustomersNoPhone({ customers: [{ name: "A", phone: "012" }, { name: "B", phone: null }] }, origin).count).toBe(1);
  });

  it("a section the person may not read is a plain line; clean sections are listed by title", () => {
    const g = buildDataGaps({ apAging: { ok: false, status: 403, message: "x" }, salesOrders: { ok: true, rows: [], truncated: false }, products: { ok: true, value: { products: [] } }, customers: { ok: true, value: { customers: [{ name: "B" }] } } }, today, origin);
    expect(g.notAvailable).toEqual(["You don't have access to the creditor (AP) aging."]);
    expect(g.gaps.map((s) => s.title)).toEqual(["Customers with no phone number"]);
    expect(g.clean).toContain("Open sales orders with no delivery date");
  });

  it("runs as the person through ctx.read: no access anywhere means notAvailable only, never another source", async () => {
    const paths: string[] = [];
    const ctx: R3Ctx = { read: async (p) => (paths.push(p), denied), origin, userId: 7, bucket: {} as R3Ctx["bucket"], now: at("2026-11-27T04:00:00Z") };
    const o = await runRound3Tool(ctx, "data_gaps", {});
    const body = JSON.parse(o.result.content[0].text);
    expect(body.gaps).toEqual([]);
    expect(body.notAvailable).toHaveLength(4);
    expect([...new Set(paths)].sort()).toEqual(["/api/scm/accounting/ap-aging", "/api/scm/mfg-products", "/api/scm/mfg-sales-orders", "/api/scm/mfg-sales-orders/customers"]);
  });

  it("money keys the person's cohort may not see stay stripped", async () => {
    const sight = { finance: false, productCost: false };
    const ctx: R3Ctx = {
      read: async (p) => {
        if (p === "/api/scm/mfg-products") return ok(redactMoney({ products: [{ code: "A", category: "SOFA", cost_price_sen: 999, sell_price_sen: 0 }] }, sight).value);
        if (p === "/api/scm/mfg-sales-orders/customers") return ok({ customers: [] });
        if (p === "/api/scm/mfg-sales-orders") return ok({ salesOrders: [], total: 0 });
        return denied;
      },
      origin,
      userId: 7,
      bucket: {} as R3Ctx["bucket"],
      now: at("2026-11-27T04:00:00Z"),
    };
    const o = await runRound3Tool(ctx, "data_gaps", {});
    expect(o.result.content[0].text).not.toContain("999");
  });
});
