import { beforeEach, describe, expect, test, vi } from "vitest";
import app from "../src/routes/deliverySheetSync";
import { isSheetReady, normSheetDate, parseFromDate, parseLimit, parseSince, sheetReadinessWording, toSheetRecord, type FeedHeadRow } from "../src/lib/delivery-sheet-feed";
import { toOutstandingPoRecord, type PoFeedRow } from "../src/lib/delivery-sheet-po-feed";
import { toAssrLegRecords, type AssrFeedRow } from "../src/lib/delivery-sheet-assr-feed";

/* Phase 3's write leg goes through the PO editor's own writers (supplier-date
 * cascade, downstream lock, AutoCount enqueue), which need a Supabase client;
 * here they are recorded, and the route's decisions around them are what is
 * pinned. */
const po = vi.hoisted(() => ({
  cascade: vi.fn(async (_sb: unknown, _args: unknown) => ({ ok: true }) as { ok: true } | { ok: false; reason: string }),
  lock: vi.fn(async (_sb: unknown, _id: string) => null as { message: string } | null),
  enqueue: vi.fn(async (_sb: unknown, _opts: unknown) => true),
}));
vi.mock("../src/db/supabase", () => ({ isSupabaseConfigured: () => true, getSupabaseService: () => ({ fake: true }) }));
vi.mock("../src/scm/lib/po-supplier-date-cascade", async (orig) => ({
  ...(await orig<typeof import("../src/scm/lib/po-supplier-date-cascade")>()),
  cascadePoSupplierDate: (sb: unknown, args: unknown) => po.cascade(sb, args),
}));
vi.mock("../src/scm/lib/downstream-lock", () => ({ poHasDownstream: (sb: unknown, id: string) => po.lock(sb, id) }));
vi.mock("../src/scm/lib/autocount-outbox", () => ({ enqueueEdit: (sb: unknown, opts: unknown) => po.enqueue(sb, opts) }));

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
  customer_so_no: "HC12481",
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
    expect(r.Remark2).toBe("READY (PARTIAL)");
    expect(r.Ready).toBe(true);
    expect(r.SOUDF_PDate).toBe("2026-08-21");
    expect(r.SalesExemptionExpiryDate).toBe("2026-10-01");
    expect(r.Remark4).toBe("Done Scheduling");
    expect(r.SOUDF_ToPONo).toBe("PO-2609-001, PO-2609-002");
    expect(r.InvAddr3).toBe("43300 Seri Kembangan");
    expect(r.InvAddr4).toBe("Selangor");
    expect(r.Region).toBe("WEST");
    expect(r.SOUDF_VENUE).toBe("Balakong Showroom");
    expect(r.LastModified).toBe(HEAD.last_modified_text);
    expect(r.Ref).toBe("HC12481");
  });

  test("Ref = ref, else customer_so_no: a native order (ref NULL) carries its reference in customer_so_no", () => {
    // ERP frontend customerRefOf reads ref || customer_so_no; every native ERP
    // order has ref NULL, so ref alone left them blank on the sheet.
    expect(toSheetRecord({ ...HEAD, ref: null, customer_so_no: "ZNT6068" }, []).Ref).toBe("ZNT6068");
    expect(toSheetRecord({ ...HEAD, ref: "HC12481", customer_so_no: "SO-SRC" }, []).Ref).toBe("HC12481");
    expect(toSheetRecord({ ...HEAD, ref: null, customer_so_no: null }, []).Ref).toBeNull();
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
    expect(feed.sql).toContain("t.status NOT IN ('CLOSED', 'DELIVERED', 'INVOICED')");
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
    expect(feed.sql).toContain("t.status IN ('CLOSED', 'DELIVERED', 'INVOICED')");
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

/* Phase 3 (owner 2026-09-16: 「第三期换 Outstanding PO」) — the Outstanding PO
 * tab and the three supplier delivery dates written back. */
const PO_LINE: PoFeedRow = {
  po_id: "9d2b9f8e-0000-4000-8000-000000000001",
  po_number: "HC-PO-2609-021",
  linked_ac_docno: "PO-004521",
  status: "SUBMITTED",
  on_hold: false,
  so_doc_no: "HC-SO-013495",
  so_ac_docno: "SO-013495",
  creditor_code: "400-S001",
  creditor_name: "Sleep Well Sdn Bhd",
  item_code: "M1",
  item_description: "Queen mattress",
  description2: "Firm",
  location: "KL",
  item_group: "MATTRESS",
  doc_date: "2026-09-01",
  remaining_qty: 2,
  delivery_date: "2026-09-20",
  supplier_delivery_date_2: "2026-09-25",
  supplier_delivery_date_3: null,
  supplier_delivery_date_4: null,
};

describe("GET /outstanding-po — the Outstanding PO tab", () => {
  test("maps every column the tab writes, keyed on the book's numbers", () => {
    expect(toOutstandingPoRecord(PO_LINE)).toEqual({
      DocNo: "PO-004521",
      ErpDocNo: "HC-PO-2609-021",
      SODocNo: "SO-013495",
      CreditorCode: "400-S001",
      CreditorName: "Sleep Well Sdn Bhd",
      ItemCode: "M1",
      ItemDescription: "Queen mattress",
      ItemDescription2: "Firm",
      Location: "KL",
      ItemGroup: "MATTRESS",
      DocDate: "2026-09-01",
      RemainingQty: 2,
      DeliveryDate: "2026-09-20",
      SupplierDeliveryDate1: "2026-09-25",
      SupplierDeliveryDate2: null,
      SupplierDeliveryDate3: null,
      Status: "SUBMITTED",
      OnHold: false,
    });
    // An ERP-made PO keys on its own number; a line without a source order has no SO Doc No.
    expect(toOutstandingPoRecord({ ...PO_LINE, linked_ac_docno: null, so_ac_docno: null, so_doc_no: null, description2: " " }))
      .toMatchObject({ DocNo: "HC-PO-2609-021", SODocNo: null, ItemDescription2: null });
  });

  test("outstanding = the PO list's own roll-up, lines with quantity left, this company only", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.purchase_order_items i/.test(sql)) return [PO_LINE];
      return [];
    });
    const res = await app.request("/outstanding-po", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(1);
    expect(body.records[0]).toMatchObject({ DocNo: "PO-004521", RemainingQty: 2 });
    const feed = seen.find((s) => /FROM scm\.purchase_order_items i/.test(s.sql))!;
    expect(feed.binds).toEqual([HOUZS]);
    expect(feed.sql).toContain("po.company_id = ?1");
    expect(feed.sql).toContain("po.status::text IN ('PARTIALLY_RECEIVED', 'SUBMITTED')");
    expect(feed.sql).toContain("i.qty - COALESCE(i.received_qty, 0) > 0");
  });

  test("401 on a wrong key, 503 without a HOUZS row", async () => {
    const { db } = fakeDb((sql) => (/FROM companies/i.test(sql) ? null : []));
    expect((await app.request("/outstanding-po", { headers: { "X-Intake-Key": "wrong" } }, env(db))).status).toBe(401);
    expect((await app.request("/outstanding-po", { headers: { "X-Intake-Key": KEY } }, env(db))).status).toBe(503);
  });
});

describe("POST /po-dates — Supplier Delivery Date 1/2/3 → supplier_delivery_date_2/3/4", () => {
  const HEAD = {
    id: PO_LINE.po_id,
    po_number: "HC-PO-2609-021",
    linked_ac_docno: "PO-004521",
    status: "SUBMITTED",
    company_id: HOUZS,
    supplier_delivery_date_2: "2026-09-25",
    supplier_delivery_date_3: null,
    supplier_delivery_date_4: null,
  };
  beforeEach(() => {
    po.cascade.mockClear();
    po.lock.mockClear();
    po.enqueue.mockClear();
    po.cascade.mockResolvedValue({ ok: true });
    po.lock.mockResolvedValue(null);
    po.enqueue.mockResolvedValue(true);
  });
  type Head = typeof HEAD;
  function post(body: unknown, heads: Head[] = [HEAD]) {
    // The heads read answers each sheet number it was asked for, as the JOIN would.
    const { db, seen } = fakeDb((sql, binds) =>
      /FROM companies/i.test(sql)
        ? { id: HOUZS }
        : /scm\.purchase_orders po/.test(sql)
          ? heads.flatMap((h) => {
              const key = [h.linked_ac_docno, h.po_number].find((k) => k && binds.includes(k));
              return key ? [{ ...h, sheet_doc_no: key }] : [];
            })
          : [],
    );
    return app
      .request(
        "/po-dates",
        { method: "POST", headers: { "X-Intake-Key": KEY, "content-type": "application/json" }, body: JSON.stringify(body) },
        env(db),
      )
      .then(async (res) => ({ res, body: (await res.json()) as any, seen }));
  }

  test("a moved date is cascaded to header + lines through the PO editor's writer, then queued to AutoCount once", async () => {
    const { res, body, seen } = await post({
      updates: [{ DocNo: "PO-004521", SupplierDeliveryDate1: "2026/09/25", SupplierDeliveryDate2: "2026-10-02" }],
    });
    expect(res.status).toBe(200);
    expect(body.written).toBe(1);
    expect(body.results[0]).toMatchObject({ DocNo: "PO-004521", ErpDocNo: "HC-PO-2609-021", ok: true, written: { supplier_delivery_date_3: "2026-10-02" }, queued: true });
    const heads = seen.find((s) => /scm\.purchase_orders po/.test(s.sql))!;
    expect(heads.binds).toEqual(["PO-004521", HOUZS]);
    expect(heads.sql).toContain("po.linked_ac_docno = v.sheet_doc_no OR po.po_number = v.sheet_doc_no");
    expect(heads.sql).toContain("po.company_id = ?");
    // Slot 2 already held 09-25, so only slot 3 is written.
    expect(po.cascade).toHaveBeenCalledTimes(1);
    expect(po.cascade.mock.calls[0]![1]).toMatchObject({ companyId: HOUZS, poId: PO_LINE.po_id, slot: 3, date: "2026-10-02", applyToLines: true, actor: null });
    expect(po.lock).toHaveBeenCalledWith({ fake: true }, PO_LINE.po_id);
    expect(po.enqueue).toHaveBeenCalledTimes(1);
    expect(po.enqueue.mock.calls[0]![1]).toMatchObject({ companyId: HOUZS, docType: "PO", docId: PO_LINE.po_id });
  });

  test("dates the ERP already holds write nothing and queue nothing; a blank keeps the ERP's date", async () => {
    const { body } = await post({ updates: [{ DocNo: "HC-PO-2609-021", SupplierDeliveryDate1: "2026-09-25", SupplierDeliveryDate2: "" }] });
    expect(body.written).toBe(0);
    expect(body.results[0]).toMatchObject({ ok: true, unchanged: true });
    expect(po.cascade).not.toHaveBeenCalled();
    expect(po.enqueue).not.toHaveBeenCalled();
  });

  test("a PO with a live GRN is locked, a received PO is refused, a cascade failure is reported — none of them queue", async () => {
    po.lock.mockResolvedValueOnce({ message: "PO has a live GRN" });
    const locked = await post({ updates: [{ DocNo: "PO-004521", SupplierDeliveryDate3: "2026-10-09" }] });
    expect(locked.body.results[0]).toMatchObject({ skipped: "po_locked", message: "PO has a live GRN" });
    expect(po.cascade).not.toHaveBeenCalled();

    const received = await post({ updates: [{ DocNo: "PO-004521", SupplierDeliveryDate3: "2026-10-09" }] }, [{ ...HEAD, status: "RECEIVED" }]);
    expect(received.body.results[0]).toMatchObject({ skipped: "po_not_outstanding", status: "RECEIVED" });
    expect(po.lock).toHaveBeenCalledTimes(1);

    po.cascade.mockResolvedValueOnce({ ok: false, reason: "Header updated but lines failed: boom" });
    const failed = await post({ updates: [{ DocNo: "PO-004521", SupplierDeliveryDate3: "2026-10-09" }] });
    expect(failed.body.results[0]).toMatchObject({ error: "Header updated but lines failed: boom", written: {} });
    expect(failed.body.written).toBe(0);
    expect(po.enqueue).not.toHaveBeenCalled();
  });

  test("validation per row: no Doc No., a bad date, nothing to write, an unknown PO; one PO's lines merge into one write", async () => {
    const { body, seen } = await post({
      updates: [
        { SupplierDeliveryDate1: "2026-10-01" },
        { DocNo: "PO-004521", SupplierDeliveryDate1: "soon" },
        { DocNo: "PO-004521" },
        { DocNo: "PO-999999", SupplierDeliveryDate1: "2026-10-01" },
        { DocNo: "PO-004521", SupplierDeliveryDate2: "2026-10-02" },
        { DocNo: "PO-004521", SupplierDeliveryDate3: "2026-10-03" },
      ],
    });
    expect(body.results[0]).toMatchObject({ skipped: "no_doc_no" });
    expect(body.results[1]).toMatchObject({ skipped: "bad_date", field: "SupplierDeliveryDate1" });
    expect(body.results[2]).toMatchObject({ skipped: "nothing_to_write" });
    expect(body.results[3]).toMatchObject({ DocNo: "PO-999999", skipped: "no_order" });
    expect(body.results[4]).toMatchObject({ ok: true, written: { supplier_delivery_date_3: "2026-10-02", supplier_delivery_date_4: "2026-10-03" } });
    expect(body.results[5]).toMatchObject({ ok: true });
    expect(body.written).toBe(2);
    const heads = seen.filter((s) => /scm\.purchase_orders po/.test(s.sql));
    expect(heads).toHaveLength(1);
    expect(heads[0]!.binds).toEqual(["PO-999999", "PO-004521", HOUZS]);
    expect(heads[0]!.sql).toContain("(VALUES (?::text), (?::text))");
    expect(po.cascade).toHaveBeenCalledTimes(2);
    expect(po.enqueue).toHaveBeenCalledTimes(1);
  });

  test("dry_run reports what would move, after the lock check, and writes and queues nothing", async () => {
    const { body } = await post({
      dry_run: true,
      updates: [{ DocNo: "PO-004521", SupplierDeliveryDate1: "2026-09-25", SupplierDeliveryDate2: "2026-10-02" }],
    });
    expect(body.dry_run).toBe(true);
    expect(body.written).toBe(0);
    expect(body.results[0]).toMatchObject({
      ok: true,
      dry_run: true,
      would_write: { supplier_delivery_date_3: "2026-10-02" },
      current: { supplier_delivery_date_2: "2026-09-25", supplier_delivery_date_3: null },
    });
    expect(po.lock).toHaveBeenCalledTimes(1);
    expect(po.cascade).not.toHaveBeenCalled();
    expect(po.enqueue).not.toHaveBeenCalled();
  });

  test("a wrong key is 401; more than the cap is 413", async () => {
    const { db } = fakeDb(() => []);
    const bad = await app.request(
      "/po-dates",
      { method: "POST", headers: { "X-Intake-Key": "wrong", "content-type": "application/json" }, body: "{}" },
      env(db),
    );
    expect(bad.status).toBe(401);
    const { res } = await post({ updates: Array.from({ length: 301 }, () => ({ DocNo: "x", SupplierDeliveryDate1: "2026-10-01" })) });
    expect(res.status).toBe(413);
  });
});

/* Owner 2026-09-17: 「我只要 Ready / ready partial 才同步进去」 — an order may ENTER
 * the sheet only when Remarks 2 says READY or READY (PARTIAL). */
describe("the READY gate", () => {
  test("READY and READY (PARTIAL) pass, typed or derived; a list of the groups that are in does not", () => {
    for (const ok of ["READY", "ready", "READY (PARTIAL)", "Ready (partial)"]) expect(isSheetReady(ok)).toBe(true);
    for (const no of ["ACC", "BEDFRAME", "MATTRESS/ACC", "BEDFRAME/ACC", "", null, "NOT READY", "READYING"]) expect(isSheetReady(no)).toBe(false);
    expect(sheetReadinessWording("PARTIAL")).toBe("READY (PARTIAL)");
    expect(sheetReadinessWording("READY")).toBe("READY");
    expect(sheetReadinessWording("ACC")).toBe("ACC");
    expect(sheetReadinessWording("")).toBeNull();
  });

  test("live lines that prove READY win over a frozen partial-groups remark; a genuinely partial typed remark is kept; no remark and short lines is not ready", () => {
    const readyLine = { doc_no: HEAD.doc_no, item_group: "MATTRESS", item_code: "M1", stock_status: "READY", cancelled: false };
    const shortLine = { doc_no: HEAD.doc_no, item_group: "BEDFRAME", item_code: "B1", stock_status: "PENDING", cancelled: false };
    expect(toSheetRecord(HEAD, [readyLine])).toMatchObject({ Remark2: "READY", Ready: true });
    expect(toSheetRecord(HEAD, [readyLine, shortLine])).toMatchObject({ Remark2: "MATTRESS", Ready: false });
    // Owner report 2026-09-17: a migrated order fully allocated in the ERP (every
    // line READY, SO at READY_TO_SHIP) still showed its frozen AutoCount word
    // ("BEDFRAME"/"ACC/BEDFRAME") on the sheet, because the header snapshot the
    // ERP never updates won over the live lines. The live READY wins now.
    expect(toSheetRecord({ ...HEAD, remark2: "ACC" }, [readyLine])).toMatchObject({ Remark2: "READY", Ready: true });
    expect(toSheetRecord({ ...HEAD, remark2: "BEDFRAME/ACC" }, [readyLine])).toMatchObject({ Remark2: "READY", Ready: true });
    // A genuinely partial order (a main line still short) keeps its typed word.
    expect(toSheetRecord({ ...HEAD, remark2: "BEDFRAME/ACC" }, [readyLine, shortLine])).toMatchObject({ Remark2: "BEDFRAME/ACC", Ready: false });
    expect(toSheetRecord({ ...HEAD, remark2: "READY (PARTIAL)" }, [shortLine])).toMatchObject({ Ready: true });
    expect(toSheetRecord(HEAD, [])).toMatchObject({ Remark2: null, Ready: false });
  });

  test("GET /ready-open returns only the READY ones of the open orders since the date, company-scoped", async () => {
    expect(parseFromDate("2026-09-15")).toBe("2026-09-15");
    expect(parseFromDate("2026/09/15")).toBeNull();
    expect(parseFromDate("2026-09-15'; --")).toBeNull();
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql)) return [HEAD, { ...HEAD, doc_no: "HC-SO-2609-090", linked_ac_docno: null }];
      if (/FROM scm\.mfg_sales_order_items/.test(sql))
        return [
          { doc_no: "HC-SO-013495", item_group: "MATTRESS", item_code: "M1", stock_status: "READY", cancelled: false },
          { doc_no: "HC-SO-2609-090", item_group: "MATTRESS", item_code: "M1", stock_status: "PENDING", cancelled: false },
        ];
      return [];
    });
    const res = await app.request("/ready-open?from=2026-09-15", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ count: 1, scanned: 2, from: "2026-09-15" });
    expect(body.records[0]).toMatchObject({ DocNo: "SO-013495", Ready: true });
    const feed = seen.find((s) => /FROM scm\.mfg_sales_orders so/.test(s.sql))!;
    expect(feed.binds).toEqual([HOUZS, "2026-09-15"]);
    expect(feed.sql).toContain("t.status NOT IN ('CLOSED', 'DELIVERED', 'INVOICED')");
    expect(feed.sql).toContain("t.so_date::date >= ?2::date");
  });

  test("/ready-open: a bad from is 400 before any read; a wrong key is 401", async () => {
    const { db, seen } = fakeDb(() => []);
    expect((await app.request("/ready-open?from=yesterday", { headers: { "X-Intake-Key": KEY } }, env(db))).status).toBe(400);
    expect((await app.request("/ready-open", { headers: { "X-Intake-Key": KEY } }, env(db))).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect((await app.request("/ready-open?from=2026-09-15", { headers: { "X-Intake-Key": "wrong" } }, env(db))).status).toBe(401);
  });
});

/* Reconcile support (owner 2026-09-20): live readiness for the DocNos a tab
 * currently holds, so the Apps Script can flip stale product-words to READY and
 * delete the genuinely-not-ready rows, while LEAVING rows the ERP does not own. */
describe("POST /prune-check", () => {
  test("live readiness + delivered-safe Deletable: stale flips READY, undelivered-short is deletable, delivered is kept, unknown is found:false", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql))
        return [
          { doc_no: "HC-SO-013495", linked_ac_docno: "SO-013495", remark2: "BEDFRAME", status: "READY_TO_SHIP" }, // frozen word, lines all in -> READY (keep)
          { doc_no: "HC-SO-2609-078", linked_ac_docno: "HC-SO-2609-078", remark2: null, status: "CONFIRMED" }, // undelivered, main pending -> DELETE
          { doc_no: "HC-SO-000012", linked_ac_docno: "SO-000012", remark2: null, status: "DELIVERED" }, // delivered + main pending -> KEEP (record)
        ];
      if (/FROM scm\.mfg_sales_order_items WHERE doc_no IN/.test(sql))
        return [
          { doc_no: "HC-SO-013495", item_group: "BEDFRAME", item_code: "B1", stock_status: "READY", cancelled: false },
          { doc_no: "HC-SO-2609-078", item_group: "BEDFRAME", item_code: "B2", stock_status: "PENDING", cancelled: false },
          { doc_no: "HC-SO-000012", item_group: "BEDFRAME", item_code: "B3", stock_status: "PENDING", cancelled: false },
        ];
      return [];
    });
    const res = await app.request(
      "/prune-check",
      { method: "POST", headers: { "X-Intake-Key": KEY, "content-type": "application/json" }, body: JSON.stringify({ doc_nos: ["SO-013495", "HC-SO-2609-078", "SO-000012", "SO-999999"] }) },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.count).toBe(4);
    expect(body.found).toBe(3);
    expect(body.would_remove).toBe(1); // only the undelivered, main-short one
    const by = Object.fromEntries(body.results.map((r: any) => [r.DocNo, r]));
    expect(by["SO-013495"]).toMatchObject({ found: true, Ready: true, Remark2: "READY", ErpDocNo: "HC-SO-013495", Deletable: false });
    expect(by["HC-SO-2609-078"]).toMatchObject({ found: true, Ready: false, Status: "CONFIRMED", Deletable: true });
    expect(by["SO-000012"]).toMatchObject({ found: true, Ready: false, Status: "DELIVERED", Deletable: false }); // delivered protected
    expect(by["SO-999999"]).toMatchObject({ found: false, Deletable: false });
    const heads = seen.find((s) => /FROM scm\.mfg_sales_orders so/.test(s.sql))!;
    expect(heads.binds[0]).toBe(HOUZS);
    expect(heads.sql).toContain("so.status::text AS status");
  });

  test("a wrong key is 401 before any read; a body without doc_nos is 400", async () => {
    const { db, seen } = fakeDb((sql) => (/FROM companies/i.test(sql) ? { id: HOUZS } : []));
    expect((await app.request("/prune-check", { method: "POST", headers: { "X-Intake-Key": "wrong", "content-type": "application/json" }, body: "{}" }, env(db))).status).toBe(401);
    expect(seen).toHaveLength(0);
    expect((await app.request("/prune-check", { method: "POST", headers: { "X-Intake-Key": KEY, "content-type": "application/json" }, body: JSON.stringify({ foo: 1 }) }, env(db))).status).toBe(400);
  });
});

describe("POST /feed-by-docnos — manual restore, full records, NO readiness gate", () => {
  test("returns full records for the requested DocNos incl. a not-ready one, company-scoped, DocNos bound once", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM scm\.mfg_sales_orders so/.test(sql))
        return [
          { ...HEAD, doc_no: "HC-SO-012596", linked_ac_docno: "SO-012596", remark2: null }, // main all ready
          { ...HEAD, doc_no: "HC-SO-013020", linked_ac_docno: "SO-013020", remark2: "BEDFRAME" }, // a mattress still pending
        ];
      if (/FROM scm\.mfg_sales_order_items WHERE doc_no IN/.test(sql))
        return [
          { doc_no: "HC-SO-012596", item_group: "BEDFRAME", item_code: "B1", stock_status: "READY", cancelled: false },
          { doc_no: "HC-SO-013020", item_group: "MATTRESS", item_code: "M1", stock_status: "PENDING", cancelled: false },
        ];
      return [];
    });
    const res = await app.request(
      "/feed-by-docnos",
      { method: "POST", headers: { "X-Intake-Key": KEY, "content-type": "application/json" }, body: JSON.stringify({ doc_nos: ["SO-012596", "SO-013020", "SO-012596"] }) },
      env(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.requested).toBe(2); // deduped
    expect(body.count).toBe(2); // BOTH returned, including the not-ready one (no gate)
    expect(body.records.map((r: any) => r.DocNo).sort()).toEqual(["SO-012596", "SO-013020"]);
    const feed = seen.find((s) => /FROM scm\.mfg_sales_orders so/.test(s.sql))!;
    expect(feed.binds[0]).toBe(HOUZS); // company scope first
    expect(feed.binds).toHaveLength(3); // company + the 2 doc numbers bound ONCE (?2.. reused for both IN lists)
  });

  test("a wrong key is 401 before any read; a body without doc_nos is 400", async () => {
    const { db, seen } = fakeDb((sql) => (/FROM companies/i.test(sql) ? { id: HOUZS } : []));
    expect((await app.request("/feed-by-docnos", { method: "POST", headers: { "X-Intake-Key": "wrong", "content-type": "application/json" }, body: "{}" }, env(db))).status).toBe(401);
    expect(seen).toHaveLength(0);
    expect((await app.request("/feed-by-docnos", { method: "POST", headers: { "X-Intake-Key": KEY, "content-type": "application/json" }, body: JSON.stringify({ foo: 1 }) }, env(db))).status).toBe(400);
  });
});

/* Owner 2026-09-17: a Service Case's inspection / pickup / delivery legs reach
 * the sheet only when OUR OWN team drives them. The SQL runs against real
 * Postgres in tests-pg/deliverySheetAssrFeedSql.pg.test.ts; here the mapper's
 * expansion and the route's shape / gating are pinned. */
const ASSR: AssrFeedRow = {
  assr_no: "ASSR/2609-012",
  status: "In Progress",
  customer_name: "Wendy",
  phone: "60127712155",
  location: "KL WAREHOUSE",
  sales_agent: "LUCAS",
  delivery_order: "HC-DO-2609-050",
  addr1: "12 Jalan Satu",
  addr2: "Taman Dua",
  addr3: null,
  addr4: "Selangor",
  inspection_by: "own",
  inspection_visit_at: "2026-09-20",
  pickup_by: "customer",
  customer_pickup_at: "2026-09-21",
  delivery_by: "own",
  do_date: "2026-09-25",
  last_modified_text: "2026-09-17 09:09:28.123456+00",
};

describe("toAssrLegRecords — one own-team leg per set date, in the sheet's record shape", () => {
  test("all three legs: keyed <ASSR-NO>#<KIND>, each on its own date, only DELIVERY carries the DO", () => {
    const legs = toAssrLegRecords(ASSR);
    expect(legs.map((l) => l.Kind)).toEqual(["INSPECT", "PICKUP", "DELIVERY"]);
    const by = Object.fromEntries(legs.map((l) => [l.Kind, l]));
    expect(by.INSPECT).toMatchObject({
      DocNo: "ASSR/2609-012#INSPECT", ErpDocNo: "ASSR/2609-012", Remark2: "SERVICE INSPECTION",
      SalesExemptionExpiryDate: "2026-09-20", TransferTo: null, DebtorName: "Wendy", Phone1: "60127712155",
      SalesLocation: "KL", SalesAgent: "LUCAS", Region: "WEST", Status: "PENDING", Ready: false,
      InvAddr1: "12 Jalan Satu", InvAddr4: "Selangor", Total: 0, SOUDF_BALANCE: 0, LastModified: ASSR.last_modified_text,
    });
    expect(by.PICKUP).toMatchObject({ DocNo: "ASSR/2609-012#PICKUP", Remark2: "SERVICE PICKUP", SalesExemptionExpiryDate: "2026-09-21", TransferTo: null });
    expect(by.DELIVERY).toMatchObject({ DocNo: "ASSR/2609-012#DELIVERY", Remark2: "SERVICE DELIVERY", SalesExemptionExpiryDate: "2026-09-25", TransferTo: "HC-DO-2609-050" });
  });

  test("the own-team gate is per leg: supplier / 3PL / unconfirmed or a missing date emits nothing", () => {
    // Every leg supplier-driven → nothing, even with all dates set.
    expect(toAssrLegRecords({ ...ASSR, inspection_by: "supplier", pickup_by: "supplier", delivery_by: "supplier" })).toEqual([]);
    // Not-yet-confirmed (null markers) → nothing.
    expect(toAssrLegRecords({ ...ASSR, inspection_by: null, pickup_by: null, delivery_by: null })).toEqual([]);
    // Own-team but no date → nothing (the date is what the team schedules against).
    expect(toAssrLegRecords({ ...ASSR, inspection_visit_at: null, pickup_by: null, delivery_by: null })).toEqual([]);
    // Only own-team pickup set → exactly the PICKUP leg.
    expect(toAssrLegRecords({ ...ASSR, inspection_by: null, delivery_by: null }).map((l) => l.Kind)).toEqual(["PICKUP"]);
  });

  test("a Singapore address routes the legs to SG", () => {
    expect(toAssrLegRecords({ ...ASSR, addr3: "SINGAPORE 408600" })[0]!.Region).toBe("SG");
  });
});

describe("GET /assr-legs", () => {
  test("wrong key 401, bad since 400, no HOUZS row 503 — all before any case is read", async () => {
    const bad = fakeDb(() => []);
    expect((await app.request("/assr-legs", { headers: { "X-Intake-Key": "wrong" } }, env(bad.db))).status).toBe(401);
    expect(bad.seen).toHaveLength(0);
    expect((await app.request("/assr-legs?since=last%20week", { headers: { "X-Intake-Key": KEY } }, env(bad.db))).status).toBe(400);
    const noco = fakeDb((sql) => (/FROM companies/i.test(sql) ? null : []));
    expect((await app.request("/assr-legs", { headers: { "X-Intake-Key": KEY } }, env(noco.db))).status).toBe(503);
  });

  test("reads the secret's company, own-team gated, expands each case to its legs and pages by case", async () => {
    const { db, seen } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM assr_cases/.test(sql)) return [ASSR];
      return [];
    });
    const res = await app.request("/assr-legs?since=2026-09-01%2000:00:00&limit=100", { headers: { "X-Intake-Key": KEY } }, env(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.cases).toBe(1);
    expect(body.count).toBe(3);
    expect(body.records.map((r: any) => r.DocNo)).toEqual(["ASSR/2609-012#INSPECT", "ASSR/2609-012#PICKUP", "ASSR/2609-012#DELIVERY"]);
    expect(body.next_since).toBe(ASSR.last_modified_text);
    expect(body.has_more).toBe(false);
    const feed = seen.find((s) => /FROM assr_cases/.test(s.sql))!;
    expect(feed.binds).toEqual([HOUZS, "2026-09-01 00:00:00", 100]);
    expect(feed.sql).toContain("company_id = ?1");
    expect(feed.sql).toContain("closed_at IS NULL");
    expect(feed.sql).toContain("archived_at IS NULL");
    expect(feed.sql).toMatch(/inspection_by\s*=\s*'own'/);
    expect(feed.sql).toMatch(/pickup_by\s*=\s*'customer'/);
    expect(feed.sql).toMatch(/delivery_by\s*=\s*'own'/);
  });

  test("has_more is measured in cases: a full case page asks the sheet to come back", async () => {
    const { db } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM assr_cases/.test(sql)) return [ASSR];
      return [];
    });
    const res = await app.request("/assr-legs?since=2026-09-01%2000:00:00&limit=1", { headers: { "X-Intake-Key": KEY } }, env(db));
    const body = (await res.json()) as any;
    expect(body.cases).toBe(1);
    expect(body.has_more).toBe(true);
  });

  test("a failed read is 502, not an empty page that would advance the checkpoint over unseen cases", async () => {
    const { db } = fakeDb((sql) => {
      if (/FROM companies/i.test(sql)) return { id: HOUZS };
      if (/FROM assr_cases/.test(sql)) throw new Error("connection reset");
      return [];
    });
    expect((await app.request("/assr-legs", { headers: { "X-Intake-Key": KEY } }, env(db))).status).toBe(502);
  });
});
