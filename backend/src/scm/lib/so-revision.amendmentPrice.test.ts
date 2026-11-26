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

type Row = Record<string, unknown>;
type PgrstResult = { data: unknown; error: null };

type SoAmendmentApproval = { approvedByUserId: string; approvalPermission: string };

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
  range() { return this; }
  not() { return this; }
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
      const inserted: Row[] = [];
      for (const it of items) {
        if (this.op === 'upsert') {
          const cols = (this.upsertOpts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const dup = cols.length > 0 && rows.some((r) => cols.every((cc) => r[cc] === it[cc]));
          if (dup && this.upsertOpts?.ignoreDuplicates) continue;
        }
        const row = { ...it };
        if (row.id == null) row.id = `${this.table}-gen-${++this.ids.n}`;
        rows.push(row);
        inserted.push(row);
      }
      const back = this.returning ? (this.wantSingle ? (inserted[0] ?? null) : inserted.map((r) => ({ ...r }))) : null;
      return (this.result = { data: back, error: null });
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
    const ord = (v: unknown): string => (v == null ? '' : String(v).padStart(12, '0'));
    for (const o of [...this.orders].reverse()) {
      out.sort((a, b) => {
        const av = ord(a[o.col]); const bv = ord(b[o.col]);
        return (av < bv ? -1 : av > bv ? 1 : 0) * (o.asc ? 1 : -1);
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
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

const DOC = 'HC-SO-2608-901';
const AMD = 'amd-price-1';

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

const APPROVED: SoAmendmentApproval = { approvedByUserId: 'user-approver', approvalPermission: 'scm.amendment.approve_lines' };
const apply = (store: Record<string, Row[]>, authority: SoAmendmentApproval | null = APPROVED) =>
  applySoAmendment(fakeSb(store), AMD, 'user-approver', undefined, { soVersion: 3, leaseToken: 'lease-1' }, authority);

const lineOf = (store: Record<string, Row[]>, id = 'L1') =>
  store.mfg_sales_order_items.find((r) => r.id === id)!;

describe('applySoAmendment — an APPROVED amendment carries the approved unit price (native SO)', () => {
  it('a price CUT below the catalogue survives the recompute', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.unit_price_sen).toBe(5000);
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

  /* docs/bugs/0942: the added line carries no AutoCount key, so the write-back
     edit the approve route queues must declare it NEW. applySoAmendment is the
     only place that knows which row it inserted, so it has to hand the id back. */
  it('returns the id of an ADDED line so the AutoCount edit can declare it new', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null,
    })];

    const res = await apply(store);

    const added = store.mfg_sales_order_items.find((r) => r.id !== 'L1')!;
    expect(res.addedLineIds).toEqual([added.id]);
  });

  it('a SPEC-only amendment adds no line, so there is nothing to declare new', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000 })];

    const res = await apply(store);

    expect(res.addedLineIds).toEqual([]);
  });

  it('ADDED lines continue the order\'s line numbering, one number each', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine(), soLine({ id: 'L2', line_no: 2 })];
    store.so_amendment_lines = [
      specLine({ id: 'al-add-1', sales_order_item_id: null, change_type: 'ADD', new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null }),
      specLine({ id: 'al-add-2', sales_order_item_id: null, change_type: 'ADD', new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null }),
    ];

    const res = await apply(store);

    const nos = res.addedLineIds.map((id) => lineOf(store, id).line_no);
    expect(nos).toEqual([3, 4]);
  });

  it('a line added to a pre-0165 order (no line numbers) stays un-numbered', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ line_no: null })];
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null,
    })];

    const res = await apply(store);

    expect(lineOf(store, res.addedLineIds[0]).line_no).toBeUndefined();
  });

  it('another company\'s line on the same doc number does not set the next number', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine(), soLine({ id: 'X9', company_id: 2, line_no: 40 })];
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_qty: 1, new_unit_price_sen: 4500, old_snapshot: null,
    })];

    const res = await apply(store);

    expect(lineOf(store, res.addedLineIds[0]).line_no).toBe(2);
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
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 0, zero_price_intended: true })];

    await apply(store);

    const line = lineOf(store);
    expect(line.unit_price_sen).toBe(0);
    expect(line.total_sen).toBe(0);
    expect(line.balance_sen).toBe(0);
  });

  it('a QTY-only amendment leaves a line already at 0 alone', async () => {
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
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_qty: 2 })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(CATALOGUE_SEN);
  });

  it('an ADDED line at 0 still takes the catalogue price — Add and Edit differ here on purpose', async () => {
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
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 0, zero_price_intended: true })];

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

    expect(lineOf(store).unit_price_sen).toBe(7300);
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

describe('applySoAmendment — a SPEC swap to an UNPRICED SKU keeps the stored price when no price is requested', () => {
  const unpriced = () => product({ code: 'MAT-2', name: 'Mattress (unpriced)', sell_price_sen: null, base_price_sen: null });
  const swapLine = (over: Partial<Row> = {}) => specLine({
    new_item_code: 'MAT-2',
    old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 850000 },
    ...over,
  });

  it('MIGRATED: stored 850000, new_unit_price_sen null -> 850000 survives the swap', async () => {
    const store = baseStore({ linkedAcDocNo: 'AC-SO-0001' });
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 850000, total_sen: 850000, balance_sen: 850000 })];
    store.so_amendment_lines = [swapLine({ new_unit_price_sen: null })];

    await apply(store);

    const line = lineOf(store);
    expect(line.item_code).toBe('MAT-2');
    expect(line.unit_price_sen).toBe(850000);
    expect(line.total_sen).toBe(850000);
  });

  it('NATIVE: stored 850000, new_unit_price_sen null -> 850000 survives the swap too', async () => {
    const store = baseStore();
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 850000, total_sen: 850000, balance_sen: 850000 })];
    store.so_amendment_lines = [swapLine({ new_unit_price_sen: null })];

    await apply(store);

    const line = lineOf(store);
    expect(line.item_code).toBe('MAT-2');
    expect(line.unit_price_sen).toBe(850000);
  });

  it('MIGRATED: an EXPLICIT 0 an approver signed still lands as 0 (unchanged behaviour)', async () => {
    const store = baseStore({ linkedAcDocNo: 'AC-SO-0001' });
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 850000, total_sen: 850000, balance_sen: 850000 })];
    store.so_amendment_lines = [swapLine({ new_unit_price_sen: 0, zero_price_intended: true })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(0);
    expect(lineOf(store).total_sen).toBe(0);
  });

  it('NATIVE: an EXPLICIT 0 an approver signed still lands as 0 (unchanged behaviour)', async () => {
    const store = baseStore();
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 850000, total_sen: 850000, balance_sen: 850000 })];
    store.so_amendment_lines = [swapLine({ new_unit_price_sen: 0, zero_price_intended: true })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(0);
  });
});

/* HC-0095 (15 Oct 2026): a 0 the operator did not type (an unpriced SKU's seed,
   sent by a pre-#4591 bundle or queued before it) zeroed priced lines on
   approval. Only a claimed 0 may land; an unclaimed one keeps the stored price. */
describe('applySoAmendment — an UNCLAIMED requested 0 keeps the stored price', () => {
  const unpriced = () => product({ code: 'MAT-2', name: 'Mattress (unpriced)', sell_price_sen: null, base_price_sen: null });
  const zeroSwap = (over: Partial<Row> = {}) => specLine({
    new_item_code: 'MAT-2', new_unit_price_sen: 0,
    old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 850000 },
    ...over,
  });
  const priced = () => [soLine({ unit_price_sen: 850000, total_sen: 850000, balance_sen: 850000 })];

  it('MIGRATED: stored 850000, unclaimed 0 -> 850000', async () => {
    const store = baseStore({ linkedAcDocNo: 'AC-SO-0001' });
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = priced();
    store.so_amendment_lines = [zeroSwap({ zero_price_intended: false })];

    await apply(store);

    expect(lineOf(store)).toMatchObject({ item_code: 'MAT-2', unit_price_sen: 850000, total_sen: 850000 });
  });

  it('NATIVE: stored 850000, unclaimed 0 -> 850000', async () => {
    const store = baseStore();
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = priced();
    store.so_amendment_lines = [zeroSwap({ zero_price_intended: false })];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(850000);
  });

  it('a row with no flag at all (queued before the column) is unclaimed too', async () => {
    const store = baseStore();
    store.mfg_products.push(unpriced());
    store.mfg_sales_order_items = priced();
    store.so_amendment_lines = [zeroSwap()];

    await apply(store);

    expect(lineOf(store).unit_price_sen).toBe(850000);
  });
});

describe('applySoAmendment — the discount channel (mig 0317)', () => {
  it('a requested discount is applied and reduces the line total', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 25000, total_sen: 25000 })];
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 25000, new_discount_sen: 12500 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.discount_sen).toBe(12500);
    expect(line.unit_price_sen).toBe(25000);
    expect(line.total_sen).toBe(12500);
    expect(line.balance_sen).toBe(12500);
  });

  it('an approved discount can never exceed the line gross — clamped, not negative', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({ new_unit_price_sen: 5000, new_discount_sen: 99000 })];

    await apply(store);

    const line = lineOf(store);
    expect(line.discount_sen).toBe(5000);
    expect(line.total_sen).toBe(0);
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

    expect(lineOf(store).discount_sen).toBe(1500);
    expect(lineOf(store).unit_price_sen).toBe(5000);
    expect(lineOf(store).total_sen).toBe(5000 - 1500);
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

/* ── The NAME must track the CODE on a SPEC change ──────────────────────────
   A SPEC that swaps item_code rewrote the code but left `description` (the
   product name) and `description2` (the variant summary) stale, so a code-swap
   amendment named the line by the OLD product on every name-first surface — the
   amend editor's SoLineCard picker, the follow-up PO's material_name, and
   anything reading description. The ADD branch already resolved the name from
   the catalog (mfg_products.name); SPEC now does too. docs/bugs/0781. */
describe('applySoAmendment — a SPEC re-syncs the line NAME to the new code\'s catalogue name', () => {
  it('rewrites description from the swapped-to code\'s catalogue name', async () => {
    const store = baseStore();
    store.mfg_products.push(product({ code: 'ACC-2', name: 'Nesting Table' }));
    store.so_amendment_lines = [specLine({ new_item_code: 'ACC-2' })];

    await apply(store);

    const line = lineOf(store);
    expect(line.item_code).toBe('ACC-2');
    expect(line.description).toBe('Nesting Table');
  });

  it('a QTY-only change leaves the name untouched (the write is scoped to SPEC)', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      change_type: 'QTY', new_qty: 2, new_unit_price_sen: CATALOGUE_SEN,
      old_snapshot: { item_code: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: CATALOGUE_SEN },
    })];

    await apply(store);

    expect(lineOf(store).qty).toBe(2);
    expect(lineOf(store).description).toBe('Side Table');
  });
});

describe('applySoAmendment — an approved delivery-date amendment is both SEEN and STICKS', () => {
  const APPROVE_DELIVERY: SoAmendmentApproval = { approvedByUserId: 'user-approver', approvalPermission: 'scm.amendment.approve_delivery' };
  const seedDeliveryAmendment = () => {
    const store = baseStore();
    (store.mfg_sales_orders[0] as Row).customer_delivery_date = '2026-11-02';
    (store.mfg_sales_orders[0] as Row).amended_delivery_date = null;
    (store.mfg_sales_order_items[0] as Row).line_delivery_date = '2026-11-02';
    (store.mfg_sales_order_items[0] as Row).line_delivery_date_overridden = false;
    (store.so_amendments[0] as Row).header_changes = { customerDeliveryDate: '2026-10-19' };
    store.so_amendment_lines = [];
    return store;
  };

  it('stamps BOTH customer_delivery_date (SEEN) and amended_delivery_date (STICKS)', async () => {
    const store = seedDeliveryAmendment();

    await apply(store, APPROVE_DELIVERY);

    const header = store.mfg_sales_orders[0] as Row;
    expect(header.customer_delivery_date).toBe('2026-10-19');
    expect(header.amended_delivery_date).toBe('2026-10-19');
  });

  it('cascades to the lines with the override flag SET, so a book re-sync cannot revert them', async () => {
    const store = seedDeliveryAmendment();

    await apply(store, APPROVE_DELIVERY);

    const line = lineOf(store);
    expect(line.line_delivery_date).toBe('2026-10-19');
    expect(line.line_delivery_date_overridden).toBe(true);
  });
});

describe('applySoAmendment — the two halves of a split SKU-swap-with-price (DEV-70)', () => {
  const PRICE_APPROVED: SoAmendmentApproval = { approvedByUserId: 'user-finance', approvalPermission: 'scm.amendment.approve_price' };
  const swapStore = (linkedAcDocNo: string | null) => {
    const store = baseStore({ linkedAcDocNo });
    store.mfg_sales_order_items = [soLine({ unit_price_sen: 850000, total_sen: 850000, balance_sen: 850000 })];
    store.mfg_products.push(product({ code: 'ACC-2', name: 'Swapped Table', sell_price_sen: 0, base_price_sen: 0 }));
    return store;
  };

  it('migrated order: the spec half swaps the SKU and keeps the stored set price', async () => {
    const store = swapStore('SO-013490');
    store.so_amendment_lines = [specLine({ new_item_code: 'ACC-2', new_unit_price_sen: null })];

    await apply(store);

    expect(lineOf(store)).toMatchObject({ item_code: 'ACC-2', unit_price_sen: 850000, total_sen: 850000 });
  });

  it('native order: the spec half keeps the stored price too, not the new SKU\'s catalogue 0', async () => {
    const store = swapStore(null);
    store.so_amendment_lines = [specLine({ new_item_code: 'ACC-2', new_unit_price_sen: null })];

    await apply(store);

    expect(lineOf(store)).toMatchObject({ item_code: 'ACC-2', unit_price_sen: 850000 });
  });

  it('the price half moves only the price: code, qty and spec stay as they are', async () => {
    const store = swapStore('SO-013490');
    store.so_amendment_lines = [specLine({ new_item_code: null, new_qty: null, new_variants: null, new_unit_price_sen: 0, zero_price_intended: true })];

    await apply(store, PRICE_APPROVED);

    expect(lineOf(store)).toMatchObject({ item_code: 'ACC-1', qty: 1, unit_price_sen: 0, total_sen: 0 });
  });
});

/* ── The SKU decides the group (docs/bugs/0514) ─────────────────────────────
   HC-SO-012243: a SPEC swapped SQUARE PILLOW (Sofa Accessory) for the free-gift
   AMN-SOFA PILLOW (Accessory) and kept fabric_accessory. That group is
   hard-bound for company 1, so MRP read the line SHORT beside 78 in stock. */
describe('applySoAmendment — a changed code takes the new SKU\'s group', () => {
  const pillowStore = () => {
    const store = baseStore();
    store.mfg_products.push(product({ code: 'PILLOW-SQ', category: 'FABRIC_ACCESSORY', name: 'Square Pillow' }));
    store.mfg_sales_order_items = [soLine({ item_code: 'PILLOW-SQ', item_group: 'fabric_accessory', description: 'Square Pillow' })];
    return store;
  };

  it('a SPEC code swap restamps item_group from the new SKU', async () => {
    const store = pillowStore();
    store.so_amendment_lines = [specLine({ new_item_code: 'ACC-1' })];

    await apply(store);

    expect(lineOf(store).item_code).toBe('ACC-1');
    expect(lineOf(store).item_group).toBe('accessory');
  });

  it('a SPEC that keeps the code leaves the stored group alone', async () => {
    const store = pillowStore();
    store.so_amendment_lines = [specLine({ new_item_code: 'PILLOW-SQ', new_qty: 2 })];

    await apply(store);

    expect(lineOf(store).item_group).toBe('fabric_accessory');
  });

  it('an ADDED line takes the catalogue group over the requested one', async () => {
    const store = baseStore();
    store.so_amendment_lines = [specLine({
      id: 'al-add', sales_order_item_id: null, change_type: 'ADD',
      new_item_code: 'ACC-1', new_variants: { itemGroup: 'others' }, old_snapshot: null,
    })];

    await apply(store);

    expect(store.mfg_sales_order_items.find((r) => r.id !== 'L1')!.item_group).toBe('accessory');
  });
});

/* ── HC-0122: the first delivery date may arrive through an amendment ───────
   SO ZNT5268 was confirmed with no Delivery Date; the amendment set one, and
   every later reschedule moved the Sales Exemption Expiry with it. */
describe('applySoAmendment — Sales Exemption Expiry freezes on the first amended delivery date', () => {
  const amendDate = async (store: Record<string, Row[]>, date: string) => {
    store.so_amendments[0] = { ...store.so_amendments[0], status: 'SUPPLIER_PENDING', header_changes: { customerDeliveryDate: date } };
    await apply(store);
  };
  const so = (store: Record<string, Row[]>) => store.mfg_sales_orders[0];

  it('seeds the expiry from the first date, then keeps it on the next reschedule', async () => {
    const store = baseStore();
    Object.assign(so(store), { status: 'CONFIRMED', customer_delivery_date: null, sales_exemption_expiry: null });

    await amendDate(store, '2026-11-10');
    expect(so(store).sales_exemption_expiry).toBe('2026-11-10');

    Object.assign(so(store), { version: 3, edit_lease_token: 'lease-1', edit_lease_expires_at: '2099-01-01T00:00:00.000Z' });
    await amendDate(store, '2026-11-20');
    expect(so(store).customer_delivery_date).toBe('2026-11-20');
    expect(so(store).sales_exemption_expiry).toBe('2026-11-10');
  });
});

/* ── Rule 2 (owner 2026-11-23) ───────────────────────────────────────────────
   Approved after the order's opening day, a PRODUCT change is costed on the day
   it is approved; a colour or a typo quantity keeps the cost; and the change goes
   on Finance's record (scm.so_product_changes). On the opening day nothing of
   this applies. Amounts are made up. */
describe('applySoAmendment — rule 2: a product change approved later is costed on the approval day', () => {
  const later = (store: Record<string, Row[]>, openedToday = false) => {
    Object.assign(store.mfg_sales_orders[0]!, {
      so_date: '2026-09-01', status: 'CONFIRMED',
      created_at: openedToday ? new Date().toISOString() : '2026-09-01T02:00:00.000Z',
    });
    store.mfg_products.push(product({ code: 'ACC-2', name: 'Big Table', base_price_sen: 14000, sell_price_sen: 14000, cost_price_sen: 5000 }));
    return store;
  };

  it('another SKU takes its cost now, stamps the day, and is recorded with selling and cost before and after', async () => {
    const store = later(baseStore());
    store.so_amendment_lines = [specLine({ new_item_code: 'ACC-2', new_unit_price_sen: 15000 })];
    await apply(store);
    const line = lineOf(store);
    const rec = store.so_product_changes?.[0];
    expect(line.item_code).toBe('ACC-2');
    expect(line.cost_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(line.line_cost_sen).not.toBe(3000);
    expect(line.line_margin_sen).toBe(Number(line.total_sen) - Number(line.line_cost_sen));
    expect(rec).toMatchObject({ route: 'AMENDMENT', window_key: AMD, change_types: ['sku'], bucket: 'SELLING', selling_before_sen: 10000, selling_after_sen: 15000, cost_before_sen: 3000 });
    expect(rec!.cost_after_sen).toBe(line.line_cost_sen);
  });

  it('a quantity that moves the selling amount costs only the extra units on the day', async () => {
    const store = later(baseStore());
    store.so_amendment_lines = [specLine({ change_type: 'QTY', new_qty: 3, new_unit_price_sen: CATALOGUE_SEN })];
    await apply(store);
    const line = lineOf(store);
    const todayUnit = (Number(line.line_cost_sen) - 3000) / 2;
    expect(Number.isInteger(todayUnit) && todayUnit > 0).toBe(true);
    expect(line.cost_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(store.so_product_changes?.[0]).toMatchObject({ change_types: ['qty'], bucket: 'SELLING' });
  });

  it('a quantity typo (selling unchanged) keeps the order-date cost and is no event', async () => {
    const store = later(baseStore());
    store.so_amendment_lines = [specLine({ change_type: 'QTY', new_qty: 2, new_unit_price_sen: 5000 })];
    await apply(store);
    const line = lineOf(store);
    expect(line.total_sen).toBe(10000);
    expect(line.line_cost_sen).toBe(6000);
    expect(line.cost_day ?? null).toBeNull();
    expect(store.so_product_changes?.[0]?.bucket ?? null).toBeNull();
  });

  it('on the opening day the line is priced as before and nothing is recorded', async () => {
    const store = later(baseStore(), true);
    store.so_amendment_lines = [specLine({ new_item_code: 'ACC-2', new_unit_price_sen: 15000 })];
    await apply(store);
    expect(lineOf(store).cost_day ?? null).toBeNull();
    expect(store.so_product_changes ?? []).toEqual([]);
  });
});
