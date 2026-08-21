// Can an APPROVED Sales Order amendment carry the money it was approved for?
//
// The owner's rule, 2026-08-16: "Any amount can be edited, unless it is locked.
// If it has proceeded and a day has passed so it locked, then it goes through
// Sales Amendment." So the amendment IS the sanctioned road for changing money
// on a locked SO, and these tests pin that the road carries it.
//
// Until this suite, it did not. applySoAmendment passed trustOperatorSelling
// = false for every NATIVE (non-AutoCount-migrated) order, so the honest-pricing
// recompute overwrote the approved unit price with the CATALOGUE price on every
// line whose SKU has one. The operator typed RM 50, an approver with
// scm.amendment.approve_* signed RM 50, and RM 100 landed on the order.
//
// Same fake-PostgREST approach as so-revision.reviseBoundPo.test.ts (route-level
// coverage is impossible here — scm rides Supabase Postgres and the harness
// rebuilds only the D1 side), and for the same reason no module is mocked: the
// REAL recompute runs against a seeded mfg_products row, so the assertions
// cannot drift from the pricing engine they are about.
import { describe, it, expect } from 'vitest';
import { applySoAmendment } from './so-revision';

/* `unknown`, not `any`: a new file's eslint ceiling is ZERO, and a fake client
   is exactly where an `any` would stop the compiler noticing a fixture that does
   not match the shape the engine reads. */
type Row = Record<string, unknown>;
type PgrstResult = { data: unknown; error: null };

/* Declared here rather than imported from so-revision so this file still RUNS
   when the source fix is stashed — the proof that these tests bite is `git stash
   && vitest` showing the price assertions fail, and an import of a type that
   does not exist yet would instead fail the whole file to load. */
type SoAmendmentApproval = { approvedByUserId: string; approvalPermission: string };

/* ── Minimal chainable, awaitable PostgREST stand-in ────────────────────────
   Covers exactly the surface applySoAmendment + snapshotSo + recomputeOneLine +
   recordSoAudit use. One addition over the reviseBoundPo suite's copy: a
   `.update(...).select(...)` returns the UPDATED rows, because the revision bump
   at the end of the apply reads its own write back and throws when it is empty. */
class Query {
  private op: 'select' | 'update' | 'delete' | 'insert' | 'upsert' = 'select';
  private filters: Array<{ kind: 'eq' | 'in'; col: string; val: unknown }> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private payload: Row | Row[] | null = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;
  private wantSingle = false;
  private limitN: number | null = null;
  private returning = false;
  private done = false;
  private result: PgrstResult | null = null;

  constructor(private store: Record<string, Row[]>, private table: string, private ids: { n: number }) {}

  select() { if (this.op !== 'select') this.returning = true; return this; }
  eq(col: string, val: unknown) { this.filters.push({ kind: 'eq', col, val }); return this; }
  in(col: string, val: unknown[]) { this.filters.push({ kind: 'in', col, val }); return this; }
  or() { return this; }
  lte() { return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }
  update(payload: Row) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(payload: Row | Row[]) { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert'; this.payload = payload; this.upsertOpts = opts ?? null; return this;
  }

  private rows() { return (this.store[this.table] ??= []); }
  private match = (r: Row) => this.filters.every((f) =>
    f.kind === 'eq' ? r[f.col] === f.val : Array.isArray(f.val) && f.val.includes(r[f.col]));

  private exec(): PgrstResult {
    if (this.done) return this.result!;
    this.done = true;
    const rows = this.rows();

    if (this.op === 'insert' || this.op === 'upsert') {
      const items: Row[] = Array.isArray(this.payload) ? this.payload : this.payload ? [this.payload] : [];
      for (const it of items) {
        if (this.op === 'upsert') {
          const cols = (this.upsertOpts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const dup = cols.length > 0 && rows.some((r) => cols.every((cc) => r[cc] === it[cc]));
          if (dup && this.upsertOpts?.ignoreDuplicates) continue;
        }
        const row = { ...it };
        if (row.id == null) row.id = `${this.table}-gen-${++this.ids.n}`;
        rows.push(row);
      }
      return (this.result = { data: null, error: null });
    }

    const filtered = rows.filter(this.match);
    if (this.op === 'update') {
      for (const r of filtered) Object.assign(r, this.payload ?? {});
      const back = this.returning ? (this.wantSingle ? (filtered[0] ?? null) : filtered) : null;
      return (this.result = { data: back, error: null });
    }
    if (this.op === 'delete') {
      this.store[this.table] = rows.filter((r) => !this.match(r));
      return (this.result = { data: null, error: null });
    }
    let out = [...filtered];
/* Sort key as a zero-padded string so an `unknown` column can be ordered
       without a numeric cast. Only `line_no` is ever ordered here. */
    const ord = (v: unknown): string => (v == null ? '' : String(v).padStart(12, '0'));
    for (const o of [...this.orders].reverse()) {
      out.sort((a, b) => {
        const av = ord(a[o.col]); const bv = ord(b[o.col]);
        return (av < bv ? -1 : av > bv ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    /* DETACHED copies, like a real PostgREST response. Handing back the live
       store objects would let a later `.update()` mutate a row the caller is
       still holding as its BEFORE value — which silently emptied the audit's
       from -> to rows here, since noteChange drops a change whose from equals
       its to. */
    out = out.map((r) => ({ ...r }));
    return (this.result = { data: this.wantSingle ? (out[0] ?? null) : out, error: null });
  }

  then<T>(onF: (v: PgrstResult) => T, onR?: (e: unknown) => T) {
    return Promise.resolve(this.exec()).then(onF, onR);
  }
}

function fakeSb(store: Record<string, Row[]>) {
  const ids = { n: 0 };
  return { from: (table: string) => new Query(store, table, ids) };
}

const DOC = 'HC-SO-2608-901';   // NOT a `2990-` doc — assertNotMirrored must pass
const AMD = 'amd-price-1';

/* ONE plain catalogue accessory at RM 100. Non-sofa with a sell price is the
   category the recompute treats as AUTHORITATIVE, i.e. exactly the case where an
   operator-entered price is at risk of being overwritten. */
const CATALOGUE_SEN = 10000;
const product = (over: Partial<Row> = {}): Row => ({
  code: 'ACC-1', company_id: 1, category: 'ACCESSORY',
  base_price_sen: CATALOGUE_SEN, price1_sen: null, cost_price_sen: 3000,
  sell_price_sen: CATALOGUE_SEN, pwp_price_sen: null,
  seat_height_prices: null, base_model: null, model_id: null, size_code: null,
  branding: null, default_free_gifts: null, name: 'Side Table', ...over,
});

const soLine = (over: Partial<Row> = {}): Row => ({
  id: 'L1', doc_no: DOC, company_id: 1, line_no: 1,
  item_code: 'ACC-1', item_group: 'accessory', description: 'Side Table',
  qty: 1, unit_price_sen: CATALOGUE_SEN, discount_sen: 0,
  total_sen: CATALOGUE_SEN, total_inc_sen: CATALOGUE_SEN, balance_sen: CATALOGUE_SEN,
  variants: null, remark: null, cancelled: false, warehouse_id: 'WH1',
  unit_cost_sen: 3000, line_cost_sen: 3000, ...over,
});

/** `linked_ac_docno` is the ONLY marker of an AutoCount-migrated order on the SO
 *  header (mig 0271); null = a NATIVE order this ERP priced itself. */
function baseStore(opts: { linkedAcDocNo?: string | null } = {}): Record<string, Row[]> {
  return {
    so_amendments: [{
      id: AMD, so_doc_no: DOC, status: 'SUPPLIER_PENDING', header_changes: null,
      so_approved_by: null, so_approved_at: null,
    }],
    so_amendment_lines: [],
    mfg_sales_orders: [{
      doc_no: DOC, company_id: 1, revision: 1, version: 3,
      linked_ac_docno: opts.linkedAcDocNo ?? null,
      customer_state: null, cross_category_source_doc_no: null,
      /* The approve-so route claims the SO's edit lease BEFORE calling the
         engine, and the engine's revision bump is predicated on holding it —
         so the fixture starts where the route leaves off. */
      edit_lease_token: 'lease-1', edit_lease_expires_at: '2099-01-01T00:00:00.000Z',
    }],
    mfg_sales_order_items: [soLine()],
    mfg_products: [product()],
    so_revisions: [],
    purchase_order_items: [],
    maintenance_config_history: [],
    mfg_so_audit_log: [],
    staff: [],
  };
}

const specLine = (over: Partial<Row> = {}): Row => ({
  id: 'al-1', amendment_id: AMD, sales_order_item_id: 'L1', change_type: 'SPEC',
  new_item_code: 'ACC-1', new_variants: null, new_qty: 1,
  new_unit_price_sen: null, new_remark: null,
  old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: CATALOGUE_SEN },
  ...over,
});

/* The approve-so route is the only caller, and it reaches here having already
   checked scm.amendment.approve_lines / approve_delivery / approve_so and the
   status transition. `concurrency` mirrors the lease it claims first. */
const APPROVED: SoAmendmentApproval = { approvedByUserId: 'user-approver', approvalPermission: 'scm.amendment.approve_lines' };
const apply = (store: Record<string, Row[]>, authority: SoAmendmentApproval | null = APPROVED) =>
  applySoAmendment(fakeSb(store), AMD, 'user-approver', undefined, { soVersion: 3, leaseToken: 'lease-1' }, authority);

const lineOf = (store: Record<string, Row[]>, id = 'L1') =>
  store.mfg_sales_order_items.find((r) => r.id === id)!;

/* ── The defect ─────────────────────────────────────────────────────────────
   Each of these is a price an approver signed for on a NATIVE order. */
describe('applySoAmendment — an APPROVED amendment carries the approved unit price (native SO)', () => {
  it('a price CUT below the catalogue survives the recompute', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.unit_price_sen).toBe(5000);   // NOT the RM100 catalogue price
    expect(line.total_sen).toBe(5000);
    expect(line.balance_sen).toBe(5000);
  });

  it('a price RISE above the catalogue survives too', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 12500, new_qty: 2 })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(12500);
    expect(lineOf(store).total_sen).toBe(25000);
  });

  it('a QTY-only amendment does not silently RE-PRICE a hand-priced line', async () => {
    /* The editor sends newUnitPriceSen on every SPEC/QTY line, not only when the
       price moved (SalesOrderDetail buildAmendmentLines). So on a line already
       discounted to RM 80, approving a pure quantity change used to reset it to
       the RM 100 catalogue — money moving on an amendment that never asked to
       move it, and which the approver's diff showed as a quantity change. */
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 8000, total_sen: 8000 })];
    store.so_amendment_lines = [specLine({
      change_type: 'QTY', new_qty: 3, new_unit_price_sen: 8000,
      old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 8000 },
    })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(8000);
    expect(lineOf(store).total_sen).toBe(24000);
  });

  it('an ADDED line lands at the approved price, not the catalogue price', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_qty: 2, new_unit_price_sen: 4500, old_snapshot: null,
    })];

    await apply(store);

    const added = store.mfg_sales_order_items.find((r) => r.id !== 'L1')!;
    expect(added.unit_price_sen).toBe(4500);
    expect(added.total_sen).toBe(9000);
  });

  it('the audit trail records the price that actually landed', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000 })];

    await apply(store);

    const entry = store.mfg_so_audit_log.at(-1)!;
    const priceChange = (entry.field_changes as Array<{ field: string; from: unknown; to: unknown }>)
      .find((f) => f.field === 'line_ACC-1_unit_price_sen');
    expect(priceChange).toMatchObject({ from: CATALOGUE_SEN, to: 5000 });
  });
});

/* ── The guard the trust flag exists to be ──────────────────────────────────
   trustOperatorSelling stops a CLIENT authoring a price. The fix must not turn
   the amendment into a second unguarded way to do that: the trust is a REQUIRED
   argument naming the approval gate the caller passed, so a caller with no
   approval gets the authoritative catalogue price exactly as before. */
/* ── RM 0, the value the suite above stops one short of ─────────────────────
   Every case above signs for a NON-ZERO price, and each one passes under plain
   `trustOperatorSelling: true`, because that flag reads `manualUnitSelling > 0`.
   Zero is the one amount it cannot carry: `true` reads a 0 as "no price was
   entered" and fills the catalogue figure back in.

   That was correct until 2026-08-18. #2425 gave the UNLOCKED road an authored
   RM 0 via 'operator-zero', so from then on a salesperson could set a line to
   RM 0 on an open SO but NOT through the sanctioned road for a locked one —
   an approver signed RM 0 and RM 100 landed, silently. These pin the value. */
describe('applySoAmendment — an approved RM 0 is a price, not a missing price', () => {
  it('a line an approver signed down to RM 0 stays at 0', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 0 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.unit_price_sen).toBe(0);      // NOT the RM100 catalogue price
    expect(line.total_sen).toBe(0);
    expect(line.balance_sen).toBe(0);
  });

  it('a QTY-only amendment leaves a line already at 0 alone', async () => {
    /* A free gift / PWP reward sits at 0. The editor sends newUnitPriceSen on
       EVERY changed line, so approving a pure quantity change used to hand that
       line the catalogue price and bill the customer for the giveaway — the
       same defect as the RM 80 -> RM 100 case above, at the value that case
       did not cover. */
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 0, total_sen: 0, balance_sen: 0 })];
    store.so_amendment_lines = [specLine({
      change_type: 'QTY', new_qty: 4, new_unit_price_sen: 0,
      old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 0 },
    })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(0);
    expect(lineOf(store).total_sen).toBe(0);
  });

  it('an amendment that requests NO price still takes the catalogue figure', async () => {
    /* The guard that keeps 'operator-zero' honest. `new_unit_price_sen: null`
       is "not requested", NOT "requested zero" — it must not be read as an
       authored 0, or every QTY change on a normally-priced line would zero it.
       specLine's default is null, so this is the untouched-price case. */
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_qty: 2 })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(CATALOGUE_SEN);
  });

  it('an ADDED line at 0 still takes the catalogue price — Add and Edit differ here on purpose', async () => {
    /* addLineTrust stays plain `true` while amendTrust became 'operator-zero'.
       An ADD line names a SKU and nothing else about it is established, so a 0
       reads as an unfilled field; editing an EXISTING line moves a price that
       is already known, which is a deliberate act. The migrated-order sibling
       of this assertion (below) predates 'operator-zero' and is the protection
       this one keeps honest — if either moves, both must. */
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_qty: 1, new_unit_price_sen: 0, old_snapshot: null,
    })];

    await apply(store);

    const added = store.mfg_sales_order_items.find((r) => r.id !== 'L1')!;
    expect(added.unit_price_sen).toBe(CATALOGUE_SEN);
  });

  it('RM 0 WITHOUT the approval authority is still refused', async () => {
    /* The ceiling. 'operator-zero' rides on `approval`, which only the
       approve-so gate constructs — so an unapproved apply cannot author a 0
       any more than it could author RM 50. */
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 0 })];

    await apply(store, null);

    expect(lineOf(store).unit_price_sen).toBe(CATALOGUE_SEN);
  });
});

describe('applySoAmendment — no approval, no authored price', () => {
  it('an apply run WITHOUT the approval authority re-prices to the catalogue', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000 })];

    await apply(store, null);

    expect(lineOf(store).unit_price_sen).toBe(CATALOGUE_SEN);
  });

  it('an ADD line with no approval authority is priced from the catalogue too', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null,
    })];

    await apply(store, null);

    const added = store.mfg_sales_order_items.find((r) => r.id !== 'L1')!;
    expect(added.unit_price_sen).toBe(CATALOGUE_SEN);
  });
});

/* ── Regressions the fix must not break ─────────────────────────────────────
   #1954 made a MIGRATED order's AutoCount price immune to the recompute, with
   'including-zero' so a migrated sofa's 0-priced sibling modules stay 0. */
describe('applySoAmendment — the MIGRATED-order protections still hold', () => {
  it('a migrated line keeps its stored AutoCount price when the amendment asks for none', async () => {
    const store = baseStore({ linkedAcDocNo: 'AC-SO-0001' });
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 7300, total_sen: 7300 })];
    store.so_amendment_lines = [specLine({
      change_type: 'QTY', new_qty: 4, new_unit_price_sen: null,
      old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 7300 },
    })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(7300);   // never the RM100 catalogue
    expect(lineOf(store).total_sen).toBe(29200);
  });

  it("a migrated line stored at 0 stays 0 — 'including-zero', not a catalogue fill", async () => {
    const store = baseStore({ linkedAcDocNo: 'AC-SO-0001' });
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 0, total_sen: 0 })];
    store.so_amendment_lines = [specLine({
      change_type: 'QTY', new_qty: 2, new_unit_price_sen: null,
      old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 0 },
    })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(0);
  });

  it('a line ADDED to a migrated order treats 0 as "not provided" — the operator is authoring it NOW', async () => {
    /* The one place 'including-zero' must NOT reach. It is a statement about a
       price AutoCount already recorded; a line being typed today has no such
       history, so 0 means the price was not entered and the catalogue fill is
       the right answer (mfg-pricing-recompute's own note on the flag). */
    const store = baseStore({ linkedAcDocNo: 'AC-SO-0001' });
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_qty: 1, new_unit_price_sen: 0, old_snapshot: null,
    })];

    await apply(store);

    const added = store.mfg_sales_order_items.find((r) => r.id !== 'L1')!;
    expect(added.unit_price_sen).toBe(CATALOGUE_SEN);
  });
});

/* ── The discount channel (mig 0317) ─────────────────────────────────────
   Until 0317 this block was titled "What an approved amendment still CANNOT
   change": so_amendment_lines had no discount column, the apply copied the
   line's existing discount forward, and reducing an amount on a locked SO was a
   unit-price change only. That gap is what silently dropped a delivery-fee
   reduction (RM 250 → 125 books as a DISCOUNT against the derived unit, and
   the derived unit is rebuilt by rederiveDeliveryFee — the discount is the one
   lever that survives). new_discount_sen now rides with new_remark's exact
   NULL semantics: null = not requested (every pre-0317 row), and the value is
   clamped to [0, qty * unit] at apply. */
describe('applySoAmendment — the discount channel (mig 0317)', () => {
  it('a requested discount is applied and reduces the line total', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 25000, total_sen: 25000 })];
    /* The fee-shape request: unit re-sent unchanged, ONLY the discount moves —
       exactly what the fee cell produces for 250 → 125. */
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 25000, new_discount_sen: 12500 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.discount_sen).toBe(12500);
    expect(line.unit_price_sen).toBe(25000);
    expect(line.total_sen).toBe(12500);      // 250.00 - 125.00
    expect(line.balance_sen).toBe(12500);
  });

  it('an approved discount can never exceed the line gross — clamped, not negative', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000, new_discount_sen: 99000 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.discount_sen).toBe(5000);    // clamped to qty * unit
    expect(line.total_sen).toBe(0);          // floor, never negative
  });

  it('a zero discount is a real request — it CLEARS the one on the line', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ discount_sen: 1500, total_sen: 8500 })];
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 10000, new_discount_sen: 0 })];

    await apply(store);

    expect(lineOf(store).discount_sen).toBe(0);
    expect(lineOf(store).total_sen).toBe(10000);
  });

  it('a NULL discount preserves the existing one — a pre-0317 amendment cannot blank a discount booked since', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ discount_sen: 1500, total_sen: 8500 })];
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000 })];

    await apply(store);

    expect(lineOf(store).discount_sen).toBe(1500);       // unchanged — no channel
    expect(lineOf(store).unit_price_sen).toBe(5000);
    expect(lineOf(store).total_sen).toBe(5000 - 1500);   // discount still applied
  });

  it('an ADDED line always lands with zero discount', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null,
    })];

    await apply(store);

    expect(store.mfg_sales_order_items.find((r) => r.id !== 'L1')!.discount_sen).toBe(0);
  });
});
