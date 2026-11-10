import { beforeEach, describe, expect, test, vi } from "vitest";

/* The six sources the top search bar gained on 2026-11-10: suppliers,
   customers (Other Debtors), credit / debit notes, receipts, delivery returns
   and payment vouchers. Driven through runGlobalSearch itself, with the
   PostgREST client replaced by a recorder, so each claim below is about the
   query that would be sent: who gets which source, the company predicate, the
   cap, and what a hit carries. */

type Call = { table: string; ops: Array<[string, unknown[]]> };
const calls: Call[] = [];
const rowsFor: Record<string, unknown[]> = {};
const failTables = new Set<string>();

function builder(table: string) {
  const call: Call = { table, ops: [] };
  calls.push(call);
  const b: Record<string, unknown> = {};
  for (const op of ["select", "or", "eq", "in", "ilike", "order", "limit", "not"]) {
    b[op] = (...args: unknown[]) => {
      call.ops.push([op, args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => void) =>
    resolve(failTables.has(table) ? { data: null, error: { message: "boom" } } : { data: rowsFor[table] ?? [], error: null });
  return b;
}

vi.mock("../src/db/supabase", () => ({
  isSupabaseConfigured: () => true,
  getSupabaseService: () => ({ from: (t: string) => builder(t) }),
}));

const { runGlobalSearch } = await import("../src/routes/search");

const emptyDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
const fakeEnv = { DB: emptyDb } as never;

const owner = { id: 1, permissions: ["*"], permissions_set: new Set(["*"]), page_access: {}, scm_l2_configured: false };
const supplierClerk = {
  id: 2, permissions: [], permissions_set: new Set<string>(), scm_l2_configured: true,
  page_access: { "scm.procurement.suppliers": "view", "scm.finance.accounting": "none", "scm.sales.returns": "none" },
};

function ctx(user: unknown, companyId = 7) {
  const vars: Record<string, unknown> = { user, companyId, allowedCompanyIds: [companyId] };
  return { get: (k: string) => vars[k] };
}

const NEWER_TABLES = ["suppliers", "acc_debtors", "acc_credit_notes", "acc_receipts", "acc_debtor_receipts", "delivery_returns", "payment_vouchers"];
const queried = (t: string) => calls.filter((c) => c.table === t);

beforeEach(() => {
  calls.length = 0;
  failTables.clear();
  for (const k of Object.keys(rowsFor)) delete rowsFor[k];
});

describe("who gets the newer sources", () => {
  test("someone with every area: all seven tables are queried, each scoped to the active company and capped", async () => {
    await runGlobalSearch(ctx(owner), fakeEnv, "tan");
    for (const t of NEWER_TABLES) {
      const q = queried(t);
      expect(q.length, t).toBe(1);
      expect(q[0].ops, t).toContainEqual(["eq", ["company_id", 7]]);
      expect(q[0].ops, t).toContainEqual(["limit", [6]]);
    }
  });

  test("a supplier-only clerk: suppliers are searched, the finance and returns tables are never asked", async () => {
    await runGlobalSearch(ctx(supplierClerk), fakeEnv, "tan");
    expect(queried("suppliers").length).toBe(1);
    for (const t of NEWER_TABLES.filter((x) => x !== "suppliers")) expect(queried(t).length, t).toBe(0);
  });

  test("no user on the context (a headless caller): none of the six", async () => {
    await runGlobalSearch(ctx(undefined), fakeEnv, "tan");
    for (const t of NEWER_TABLES) expect(queried(t).length, t).toBe(0);
    expect(queried("mfg_sales_orders").length).toBeGreaterThan(0);
  });
});

describe("what a hit carries", () => {
  test("status, link and a readable subtitle, per source", async () => {
    rowsFor.suppliers = [{ id: "s1", code: "OHANA", name: "Ohana Furniture", contact_person: "Mr Lim", status: "ACTIVE" }];
    rowsFor.acc_debtors = [{ id: "d1", code: "OD-001", name: "Tan Holdings", phone: "0123456789", is_active: false }];
    rowsFor.acc_credit_notes = [{ id: "n1", note_number: "CN-2611-001", kind: "CN", party_name: "Tan", so_doc_no: "SO-1", note_date: "2026-11-01", status: "POSTED" }];
    rowsFor.acc_receipts = [{ id: "g1", receipt_number: "RCT-001", payer_name: "Tan", receipt_date: "2026-11-02", status: "POSTED" }];
    rowsFor.acc_debtor_receipts = [{ id: "r1", receipt_number: "ODR-001", receipt_date: "2026-11-03", status: "DRAFT", debtor: { name: "Tan Holdings" } }];
    rowsFor.delivery_returns = [{ id: "x1", return_number: "DR-001", do_doc_no: "DO-9", debtor_name: "Tan", return_date: "2026-11-04", status: "RECEIVED" }];
    rowsFor.payment_vouchers = [{ id: "p1", pv_number: "PV-001", payee_name: "Tan", bill_ref: "B-7", voucher_date: "2026-11-05", status: "DRAFT" }];
    const { hits, degraded } = await runGlobalSearch(ctx(owner), fakeEnv, "tan");
    expect(degraded).toEqual([]);
    const by = (type: string) => hits.filter((h) => h.type === type);
    expect(by("supplier")[0]).toMatchObject({ title: "OHANA · Ohana Furniture", status: "ACTIVE", link: "/scm/suppliers/s1" });
    expect(by("customer")[0]).toMatchObject({ title: "OD-001 · Tan Holdings", status: "INACTIVE", link: "/scm/other-debtors/d1" });
    expect(by("credit_note")[0]).toMatchObject({ title: "CN-2611-001", subtitle: "Credit note · Tan · SO SO-1", status: "POSTED", link: "/scm/credit-notes/n1" });
    expect(by("receipt").map((h) => h.link)).toEqual(["/scm/receipts/debtor/r1", "/scm/receipts/sundry/g1"]);
    expect(by("receipt")[0]).toMatchObject({ subtitle: "Tan Holdings", status: "DRAFT" });
    expect(by("delivery_return")[0]).toMatchObject({ subtitle: "Tan · DO DO-9", status: "RECEIVED", link: "/scm/delivery-returns/x1" });
    expect(by("payment_voucher")[0]).toMatchObject({ subtitle: "Tan · B-7", status: "DRAFT", link: "/scm/payment-vouchers/p1" });
  });

  test("the older documents now carry their status too", async () => {
    rowsFor.purchase_orders = [{ id: "po1", po_number: "PO-1", po_date: "2026-11-01", status: "SUBMITTED", supplier: { name: "Ohana" } }];
    const { hits } = await runGlobalSearch(ctx(owner), fakeEnv, "po");
    expect(hits.find((h) => h.type === "purchase_order")).toMatchObject({ status: "SUBMITTED" });
  });

  test("a table that cannot be read is named once in degraded, never shown as empty", async () => {
    failTables.add("acc_receipts");
    failTables.add("acc_debtor_receipts");
    failTables.add("payment_vouchers");
    const { degraded } = await runGlobalSearch(ctx(owner), fakeEnv, "tan");
    expect(degraded.filter((d) => d === "receipt")).toEqual(["receipt"]);
    expect(degraded).toContain("payment_voucher");
  });

  test("a source the caller cannot open is not reported as degraded either", async () => {
    failTables.add("payment_vouchers");
    const { degraded } = await runGlobalSearch(ctx(supplierClerk), fakeEnv, "tan");
    expect(degraded).not.toContain("payment_voucher");
  });
});
