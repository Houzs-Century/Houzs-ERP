import { describe, expect, test } from "vitest";
import app from "../src/routes/deliverySheetSync";
import { normSheetDate, parseLimit, parseSince, toSheetRecord, type FeedHeadRow } from "../src/lib/delivery-sheet-feed";

/* The HC Delivery sheet's ERP sync (owner 2026-09-15: stop the AutoCount pull,
 * feed the sheet from the ERP). Pins the shared-secret guard, the company
 * scoping of both legs, and the AutoCount-named record the sheet's writer
 * reads. The SQL itself runs against real Postgres in
 * tests-pg/deliverySheetFeedSql.pg.test.ts; here the D1 surface is a fake that
 * records what was issued. */

const KEY = "test-sheet-sync-key";
const HOUZS = 1;

type Recorded = { sql: string; binds: unknown[] };
function fakeDb(answer: (sql: string, binds: unknown[]) => unknown) {
  const seen: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) {
          binds = b;
          return stmt;
        },
        async all<T>() {
          seen.push({ sql, binds });
          const r = answer(sql, binds);
          return { results: (Array.isArray(r) ? r : []) as T[] };
        },
        async first<T>() {
          seen.push({ sql, binds });
          const r = answer(sql, binds);
          return (Array.isArray(r) ? r[0] ?? null : r ?? null) as T | null;
        },
        async run() {
          seen.push({ sql, binds });
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return { db, seen };
}

const HEAD: FeedHeadRow = {
  doc_no: "HC-SO-013495",
  linked_ac_docno: "SO-013495",
  so_date: "2026-08-20",
  ref: "HC12481",
  branding: "AKEMI",
  debtor_name: "Wendy",
  phone: "60127712155",
  sales_location: "KL WAREHOUSE",
  agent: "LUCAS",
  salesperson_name: null,
  local_total_sen: 538800,
  balance_sen_live: 100000,
  remark2: null,
  remark3: "internal",
  remark4: "Done Scheduling",
  note: "lift access",
  processing_date: "2026-08-21",
  customer_delivery_date: "2026-10-01",
  address1: "12 Jalan Satu",
  address2: "Taman Dua",
  address3: null,
  address4: null,
  postcode: "43300",
  city: "Seri Kembangan",
  customer_state: "Selangor",
  venue: "Balakong Showroom",
  status: "CONFIRMED",
  do_numbers: "HC-DO-2609-001",
  po_numbers: "PO-2609-001, PO-2609-002",
  last_modified_text: "2026-09-15 09:09:28.123456+00",
};

function env(db: unknown) {
  return { DB: db, SHEET_SYNC_KEY: KEY } as any;
}

describe("toSheetRecord — the AutoCount-named record the sheet writes", () => {
  test("keys the row on the AutoCount number and maps every column the writer reads", () => {
    const r = toSheetRecord(HEAD, [
      { doc_no: HEAD.doc_no, item_group: "MATTRESS", item_code: "M1", stock_status: "READY", cancelled: false },
      { doc_no: HEAD.doc_no, item_group: "ACCESSORIES", item_code: "A1", stock_status: "PENDING", cancelled: false },
    ]);
    expect(r.DocNo).toBe("SO-013495");
    expect(r.ErpDocNo).toBe("HC-SO-013495");
    expect(r.TransferTo).toBe("HC-DO-2609-001");
    expect(r.DocDate).toBe("2026-08-20");
    expect(r.SalesLocation).toBe("KL");
    expect(r.SalesAgent).toBeTruthy();
    expect(r.Total).toBe(5388);
    expect(r.SOUDF_BALANCE).toBe(1000);
    // No header Remarks 2 → the readiness wording the SO list derives.
    expect(r.Remark2).toBe("PARTIAL");
    expect(r.SOUDF_PDate).toBe("2026-08-21");
    expect(r.SalesExemptionExpiryDate).toBe("2026-10-01");
    expect(r.Remark4).toBe("Done Scheduling");
    expect(r.SOUDF_ToPONo).toBe("PO-2609-001, PO-2609-002");
    expect(r.InvAddr3).toBe("43300 Seri Kembangan");
    expect(r.InvAddr4).toBe("Selangor");
    expect(r.Region).toBe("WEST");
    expect(r.SOUDF_VENUE).toBe("Balakong Showroom");
    expect(r.LastModified).toBe(HEAD.last_modified_text);
  });

  test("a native order keys on its own number; a Singapore address routes SG; a stored Remarks 2 wins", () => {
    const r = toSheetRecord(
      { ...HEAD, doc_no: "HC-SO-2609-078", linked_ac_docno: "HC-SO-2609-078", address3: "SINGAPORE 123456", remark2: "READY (PARTIAL)" },
      [],
    );
    expect(r.DocNo).toBe("HC-SO-2609-078");
    expect(r.Region).toBe("SG");
    expect(r.Remark2).toBe("READY (PARTIAL)");
  });

  test("East Malaysia branches route EAST", () => {
    expect(toSheetRecord({ ...HEAD, sales_location: "SRW WAREHOUSE" }, []).Region).toBe("EAST");
  });
});

describe("parsers", () => {
  test("since accepts the old script's checkpoint and Postgres's own timestamptz text", () => {
    expect(parseSince("")).toBe("2000-01-01 00:00:00");
    expect(parseSince("2026-09-15 17:09:28")).toBe("2026-09-15 17:09:28");
    expect(parseSince("2026-09-15 09:09:28.123456+00")).toBe("2026-09-15 09:09:28.123456+00");
    expect(parseSince("2026-09-15T09:09:28Z")).toBe("2026-09-15T09:09:28Z");
    expect(parseSince("yesterday")).toBeNull();
    expect(parseSince("2026-09-15'; DROP TABLE x; --")).toBeNull();
  });
  test("limit defaults and caps", () => {
    expect(parseLimit(undefined)).toBe(300);
    expect(parseLimit("50")).toBe(50);
    expect(parseLimit("99999")).toBe(1000);
  });
  test("sheet dates in both column formats", () => {
    expect(normSheetDate("2026/10/01")).toBe("2026-10-01");
    expect(normSheetDate("2026-10-01")).toBe("2026-10-01");
    expect(normSheetDate("")).toBeNull();
  });
});

describe("GET /so-since", () => {
  test("a wrong key is 401 before anything is read", async () => {
    const { db, seen } = fakeDb(() => []);
    const res = await app.request("/so-since", { headers: { "X-Intake-Key": "wrong" } }, env(db));
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("a malformed checkpoint is 400, never bound into ::timestamptz", async () => {
    const { db, seen } = fakeDb(() => []);
    const res = await app.request("/so-since?since=last%20week", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("refuses with 503 when the companies master has no HOUZS row", async () => {
    const { db } = fakeDb((sql) => (/FROM companies/i.test(sql) ? null : []));
    const res = await app.request("/so-since", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "company_unresolved" });
  });

  test("reads the secret's company only, pages by LastModified and hands back the next checkpoint", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql)) return [HEAD];
      if (/FROM scm\.mfg_sales_order_items WHERE doc_no IN/.test(sql))
        return [{ doc_no: HEAD.doc_no, item_group: "MATTRESS", item_code: "M1", stock_status: "READY", cancelled: false }];
      return [];
    });
    const res = await app.request(
      "/so-since?since=2026-09-01%2000:00:00&limit=1",
      { headers: { "X-Intake-Key": KEY } },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(1);
    expect(body.records[0].DocNo).toBe("SO-013495");
    expect(body.records[0].Remark2).toBe("READY");
    expect(body.next_since).toBe(HEAD.last_modified_text);
    expect(body.has_more).toBe(true);
    const feed = seen.find((s) => /FROM scm\.mfg_sales_orders so/.test(s.sql))!;
    expect(feed.binds).toEqual([HOUZS, "2026-09-01 00:00:00", 1]);
    expect(feed.sql).toContain("so.company_id = ?1");
    const lines = seen.find((s) => /mfg_sales_order_items WHERE doc_no IN/.test(s.sql))!;
    expect(lines.binds).toEqual(["HC-SO-013495"]);
  });

  test("a failed head read is 502, not an empty page that would advance nothing and hide the outage", async () => {
    const { db } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql)) throw new Error("connection reset");
      return [];
    });
    const res = await app.request("/so-since", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(502);
  });
});

describe("GET /overdue and /balance-collection — the two daily lists (phase 2)", () => {
  test("overdue: undelivered orders past their delivery date, Malaysian day, company-scoped, oldest first", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql)) return [{ ...HEAD, customer_delivery_date: "2026-08-01" }];
      return [];
    });
    const res = await app.request("/overdue", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(1);
    expect(body.records[0]).toMatchObject({ DocNo: "SO-013495", SalesExemptionExpiryDate: "2026-08-01", SOUDF_VENUE: "Balakong Showroom" });
    const feed = seen.find((s) => /FROM scm\.mfg_sales_orders so/.test(s.sql))!;
    expect(feed.binds).toEqual([HOUZS]);
    expect(feed.sql).toContain("t.status NOT IN ('DELIVERED', 'INVOICED', 'CLOSED')");
    expect(feed.sql).toContain("t.customer_delivery_date::date < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date");
    expect(feed.sql).toContain("ORDER BY t.customer_delivery_date, t.doc_no");
    expect(feed.sql).not.toContain("LIMIT");
  });

  test("balance-collection: delivered orders still owing, company-scoped", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql)) return [{ ...HEAD, status: "DELIVERED", balance_sen_live: 250000 }];
      return [];
    });
    const res = await app.request("/balance-collection", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.records[0]).toMatchObject({ DocNo: "SO-013495", SOUDF_BALANCE: 2500, Status: "DELIVERED" });
    const feed = seen.find((s) => /FROM scm\.mfg_sales_orders so/.test(s.sql))!;
    expect(feed.binds).toEqual([HOUZS]);
    expect(feed.sql).toContain("t.status IN ('DELIVERED', 'INVOICED', 'CLOSED')");
    expect(feed.sql).toContain("t.balance_sen_live > 0");
  });

  test("both lists are 401 on a wrong key and 503 without a HOUZS row", async () => {
    const { db } = fakeDb((sql) => (/FROM companies/i.test(sql) ? null : []));
    for (const path of ["/overdue", "/balance-collection"]) {
      expect((await app.request(path, { headers: { "X-Intake-Key": "wrong" } }, env(db))).status).toBe(401);
      expect((await app.request(path, { headers: { "X-Intake-Key": KEY } }, env(db))).status).toBe(503);
    }
  });
});

describe("POST /updates — col A → remark4, col O → customer_delivery_date", () => {
  function post(body: unknown, answer: (sql: string, binds: unknown[]) => unknown) {
    const { db, seen } = fakeDb(answer);
    return app
      .request(
        "/updates",
        { method: "POST", headers: { "X-Intake-Key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) },
        env(db),
      )
      .then(async (res) => ({ res, body: (await res.json()) as any, seen }));
  }

  test("writes both columns, scoped to the secret's company, found by the sheet's AutoCount number", async () => {
    const { res, body, seen } = await post(
      { updates: [{ DocNo: "SO-013495", Remark4: "Done Scheduling", ExpiryDate: "2026/10/01" }] },
      (sql) =>
        /FROM companies/i.test(sql)
          ? { id: HOUZS }
          : /UPDATE scm\.mfg_sales_orders/.test(sql)
            ? [{ doc_no: "HC-SO-013495", sheet_doc_no: "SO-013495" }]
            : [],
    );
    expect(res.status).toBe(200);
    expect(body.written).toBe(1);
    expect(body.results[0]).toMatchObject({ DocNo: "SO-013495", ErpDocNo: "HC-SO-013495", ok: true, delivery_date: "2026-10-01" });
    const upd = seen.find((s) => /UPDATE scm\.mfg_sales_orders/.test(s.sql))!;
    expect(upd.binds).toEqual(["SO-013495", "Done Scheduling", "2026-10-01", HOUZS]);
    expect(upd.sql).toContain("so.company_id = ?");
    expect(upd.sql).toContain("so.linked_ac_docno = v.sheet_doc_no OR so.doc_no = v.sheet_doc_no");
  });

  test("one statement per batch: a blank date keeps the ERP's date, an absent Remark4 keeps the remark, a row with neither is skipped, a repeated Doc. No. is sent once (last wins)", async () => {
    const { body, seen } = await post(
      {
        updates: [
          { DocNo: "SO-1", Remark4: "", ExpiryDate: "" },
          { DocNo: "SO-2", ExpiryDate: "2026-10-02" },
          { DocNo: "SO-3" },
          { DocNo: "SO-1", Remark4: "Done Scheduling" },
        ],
      },
      (sql) => (/FROM companies/i.test(sql) ? { id: HOUZS } : /UPDATE/.test(sql) ? [{ doc_no: "HC-SO-1", sheet_doc_no: "SO-1" }] : []),
    );
    const upds = seen.filter((s) => /UPDATE scm\.mfg_sales_orders/.test(s.sql));
    expect(upds).toHaveLength(1);
    expect(upds[0]!.binds).toEqual(["SO-1", "Done Scheduling", null, "SO-2", null, "2026-10-02", HOUZS]);
    expect(upds[0]!.sql).toContain("(VALUES (?::text, ?::text, ?::date), (?::text, ?::text, ?::date))");
    expect(body.results[2]).toMatchObject({ DocNo: "SO-3", skipped: "nothing_to_write" });
    // Both SO-1 rows report the write; SO-2 found no order.
    expect(body.results[0]).toMatchObject({ DocNo: "SO-1", ok: true });
    expect(body.results[3]).toMatchObject({ DocNo: "SO-1", ok: true });
    expect(body.results[1]).toMatchObject({ DocNo: "SO-2", skipped: "no_order" });
    expect(body.written).toBe(2);
  });

  test("an unknown or other-company Doc. No. writes nothing and says so", async () => {
    const { body } = await post(
      { updates: [{ DocNo: "2990-SO-2609-001", Remark4: "x" }] },
      (sql) => (/FROM companies/i.test(sql) ? { id: HOUZS } : []),
    );
    expect(body.written).toBe(0);
    expect(body.results[0]).toMatchObject({ skipped: "no_order" });
  });

  test("a wrong key is 401; more than the cap is 413", async () => {
    const { db } = fakeDb(() => []);
    const bad = await app.request(
      "/updates",
      { method: "POST", headers: { "X-Intake-Key": "wrong", "content-type": "application/json" }, body: "{}" },
      env(db),
    );
    expect(bad.status).toBe(401);
    const { res } = await post({ updates: Array.from({ length: 301 }, () => ({ DocNo: "x", Remark4: "y" })) }, () => ({ id: HOUZS }));
    expect(res.status).toBe(413);
  });
});
