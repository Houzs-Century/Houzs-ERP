import { describe, expect, test, vi } from 'vitest';
import {
  noteScanDraftAccepted,
  buildCorrectedSlipFromSo,
  alignSoLinesToSlip,
  keepPersonChanges,
  snapshotDraftBaseline,
  CARRIED_NOT_INVERTED,
} from './scan-sample-review';
import { changedFields } from './scan-slip-fields';
import { slipAliasPairs } from './scan-field-aliases';

type Row = Record<string, any>;

function fakeSvc(tables: Record<string, Row[]>, opts?: { throwOn?: string }) {
  const updates: Array<{ table: string; patch: Row; rows: Row[] }> = [];
  class Q {
    private preds: Array<(r: Row) => boolean> = [];
    private op: 'select' | 'update' = 'select';
    private patch: Row = {};
    private cap: number | null = null;
    constructor(private rows: Row[], private table: string) {}
    select() { return this; }
    order() { return this; }
    limit(n: number) { this.cap = n; return this; }
    update(p: Row) { this.op = 'update'; this.patch = p; return this; }
    eq(c: string, v: unknown) { this.preds.push((r) => String(r[c]) === String(v)); return this; }
    not(c: string, op: string, v: unknown) {
      if (op === 'is' && v === null) this.preds.push((r) => r[c] != null);
      else if (op === 'in') {
        const list = String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
        this.preds.push((r) => !list.includes(String(r[c])));
      }
      return this;
    }
    or(expr: string) {
      if (expr === 'source.is.null,source.neq.automation') {
        this.preds.push((r) => r.source == null || r.source !== 'automation');
      }
      return this;
    }
    private run(): Row[] {
      if (opts?.throwOn === this.table) throw new Error(`boom: ${this.table}`);
      let hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
      if (this.cap != null) hit = hit.slice(0, this.cap);
      if (this.op === 'update') {
        updates.push({ table: this.table, patch: this.patch, rows: [...hit] });
        for (const r of hit) Object.assign(r, this.patch);
      }
      return hit;
    }
    maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
    then(res: (v: any) => any, rej?: (e: any) => any) {
      let out: { data: Row[]; error: null };
      try { out = { data: this.run(), error: null }; } catch (e) { return Promise.reject(e).then(res, rej); }
      return Promise.resolve(out).then(res, rej);
    }
  }
  return {
    svc: { from: (t: string) => new Q((tables[t] ||= []), t) } as never,
    updates,
  };
}


const slipLine = (over: Row = {}): Row => ({
  rawText: 'Bamboo Cruise K', rawSpec: null,
  divanHeightInches: null, legHeightInches: null, gapInches: null, noLeg: false,
  seatHeightInches: null, qtyGuess: 1, priceRmGuess: 1200,
  skuMatch: { code: 'BC-K', confidence: 0.7, reason: 'catalog keyword' },
  fabricMatch: null, specialsMatch: [], notes: null,
  ...over,
});

const extractedSlip = (over: Row = {}): Row => ({
  customerName: 'Tan Ah Kow',
  address: '12 Jalan Mawar',
  addressLine1: '12 Jalan Mawar',
  city: 'Skudai', postcode: '81300',
  addressStateMatch: { value: 'Johor', confidence: 0.9, reason: 'read' },
  phones: ['127778888'],
  location: 'JB fair', deliveryDate: null, slipDate: null, salesRep: 'Aaron',
  customerSoRef: 'HC14032', paymentMethod: 'cash dep 500',
  depositRm: 500, totalRm: 1200, remarks: 'call before deliver', approvalCode: null,
  paymentMethodMatch: { value: 'Cash', confidence: 0.9, reason: 'read' },
  bankMatch: null, onlineTypeMatch: null, installmentPlanMatch: null,
  customerTypeMatch: { value: 'Retail', confidence: 0.8, reason: 'read' },
  buildingTypeMatch: null,
  locationMatch: null, images: [], payments: [],
  lines: [slipLine()],
  ...over,
});

const soHeader = (over: Row = {}): Row => ({
  doc_no: 'SO-2607-001',
  debtor_name: 'Tan Ah Kow', phone: '+60127778888', emergency_contact_phone: null,
  address1: '12 Jalan Mawar', city: 'Skudai', postcode: '81300', customer_state: 'Johor',
  customer_so_no: 'HC14032', customer_type: 'Retail', building_type: null,
  payment_method: 'Cash', merchant_provider: null, approval_code: null,
  deposit_sen: 50000, customer_delivery_date: null,
  ...over,
});

const soItem = (over: Row = {}): Row => ({
  doc_no: 'SO-2607-001', item_group: 'bedframe', item_code: 'BC-K',
  qty: 1, unit_price_sen: 139000, variants: null, cancelled: false, line_no: 0,
  ...over,
});


describe('buildCorrectedSlipFromSo — an untouched SO must produce ZERO diff', () => {
  test('inverting an unedited SO returns the extraction byte-for-byte', () => {
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem()]);
    expect(JSON.stringify(out)).toBe(JSON.stringify(ai));
  });

  test('the create core repricing the line is NOT read back as a correction', () => {
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem({ unit_price_sen: 139000 })]);
    expect((out?.lines as Row[])[0].priceRmGuess).toBe(1200);
  });

  test('the venue autofill and the duplicate note prefix are NOT read back', () => {
    expect(CARRIED_NOT_INVERTED).toContain('locationMatch');
    expect(CARRIED_NOT_INVERTED).toContain('remarks');
    expect(CARRIED_NOT_INVERTED).toContain('slipDate');
    expect(CARRIED_NOT_INVERTED).not.toContain('processingDate');
    expect(CARRIED_NOT_INVERTED).toContain('priceRmGuess');
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem()]);
    expect(out?.locationMatch).toBeNull();
    expect(out?.remarks).toBe('call before deliver');
  });

  test('service lines and free-gift lines are not slip lines', () => {
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [
      soItem(),
      soItem({ item_group: 'service', item_code: 'SVC-DELIVERY', line_no: 1 }),
      soItem({ item_code: 'GIFT-PILLOW', variants: { freeGift: { campaignName: 'x' } }, line_no: 2 }),
    ]);
    expect((out?.lines as Row[]).length).toBe(1);
  });
});

describe('buildCorrectedSlipFromSo — the operator corrections that must survive', () => {
  test('a corrected SKU keeps the slip rawText paired with the operator code', () => {
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem({ item_code: 'BC-KING-2026' })]);
    const line = (out?.lines as Row[])[0];
    expect(line.rawText).toBe('Bamboo Cruise K');
    expect(line.skuMatch).toEqual({ code: 'BC-KING-2026', confidence: 1, reason: 'operator-confirmed' });
  });

  test('a corrected customerSoRef / address split / customer name land on the blob', () => {
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader({
      debtor_name: 'Tan Ah Kaw', customer_so_no: 'HC 14032', address1: '12A Jalan Mawar',
      city: 'Johor Bahru', postcode: '81300', customer_state: 'Johor',
    }), [soItem()]);
    expect(out?.customerName).toBe('Tan Ah Kaw');
    expect(out?.customerSoRef).toBe('HC 14032');
    expect(out?.addressLine1).toBe('12A Jalan Mawar');
    expect(out?.city).toBe('Johor Bahru');
    expect(out?.addressStateMatch).toEqual({ value: 'Johor', confidence: 0.9, reason: 'read' });
  });

  test('a corrected fabric code lands, an untouched category axis does not', () => {
    const ai = extractedSlip({
      lines: [slipLine({ fabricMatch: { code: 'BO315-2', confidence: 0.6, reason: 'read' } })],
    });
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem({ variants: { fabricCode: 'BO315-02' } })]);
    expect((out?.lines as Row[])[0].fabricMatch)
      .toEqual({ code: 'BO315-02', confidence: 1, reason: 'operator-confirmed' });
  });

  test('a corrected payment method + bank land, and bank stays carried off-Merchant', () => {
    const ai = extractedSlip({ bankMatch: { value: 'Maybank', confidence: 0.5, reason: 'read' } });
    const asCash = buildCorrectedSlipFromSo(ai, soHeader(), [soItem()]);
    expect(asCash?.bankMatch).toEqual({ value: 'Maybank', confidence: 0.5, reason: 'read' });
    const asMerchant = buildCorrectedSlipFromSo(
      ai, soHeader({ payment_method: 'Merchant', merchant_provider: 'Public Bank' }), [soItem()],
    );
    expect(asMerchant?.paymentMethodMatch)
      .toEqual({ value: 'Merchant', confidence: 1, reason: 'operator-confirmed' });
    expect(asMerchant?.bankMatch)
      .toEqual({ value: 'Public Bank', confidence: 1, reason: 'operator-confirmed' });
  });

  test('the shell placeholder name inverts to null, never to its own sentence', () => {
    const ai = extractedSlip({ customerName: null });
    const out = buildCorrectedSlipFromSo(ai, soHeader({ debtor_name: 'Scan — please complete' }), [soItem()]);
    expect(out?.customerName).toBeNull();
  });
});

describe('alignSoLinesToSlip — never assert a handwriting -> SKU pair we are not sure of', () => {
  const slip = (code: string, raw: string) => slipLine({ rawText: raw, skuMatch: { code, confidence: 1, reason: 'r' } });

  test('unchanged codes anchor 1:1', () => {
    const out = alignSoLinesToSlip(
      [slip('A', 'ra'), slip('B', 'rb')],
      [soItem({ item_code: 'A' }), soItem({ item_code: 'B' })],
    );
    expect(out.map((p) => p.slip?.rawText)).toEqual(['ra', 'rb']);
  });

  test('one re-coded line between two anchors pairs positionally', () => {
    const out = alignSoLinesToSlip(
      [slip('A', 'ra'), slip('B', 'rb'), slip('C', 'rc')],
      [soItem({ item_code: 'A' }), soItem({ item_code: 'B2' }), soItem({ item_code: 'C' })],
    );
    expect(out.map((p) => p.slip?.rawText)).toEqual(['ra', 'rb', 'rc']);
  });

  test('an operator-added line carries no slip provenance', () => {
    const out = alignSoLinesToSlip([slip('A', 'ra')], [soItem({ item_code: 'A' }), soItem({ item_code: 'NEW' })]);
    expect(out[1].slip).toBeNull();
  });

  test('an ambiguous gap (a delete AND a re-code together) refuses to guess', () => {
    const out = alignSoLinesToSlip(
      [slip('A', 'ra'), slip('B', 'rb')],
      [soItem({ item_code: 'ZZ' })],
    );
    expect(out.length).toBe(1);
    expect(out[0].slip).toBeNull();
  });

  test('an unpairable line still carries the operator code, with empty rawText', () => {
    const ai = extractedSlip({ lines: [slipLine({ skuMatch: { code: 'A', confidence: 1, reason: 'r' } })] });
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [
      soItem({ item_code: 'A' }), soItem({ item_code: 'NEW-SKU', line_no: 1 }),
    ]);
    const added = (out?.lines as Row[])[1];
    expect(added.rawText).toBe('');
    expect(added.skuMatch).toEqual({ code: 'NEW-SKU', confidence: 1, reason: 'operator-confirmed' });
  });
});


const SAMPLE_ID = 'sample-1';
const DOC = 'SO-2607-001';

function scanWorld(over: { audit?: Row[]; header?: Row; items?: Row[]; sampleStatus?: string } = {}) {
  const ai = extractedSlip();
  return {
    ai,
    tables: {
      scan_jobs: [{ id: 'job-1', so_doc_no: DOC, sample_id: SAMPLE_ID, created_at: '2026-07-21T00:00:00Z' }],
      mfg_so_audit_log: over.audit ?? [{ id: 1, so_doc_no: DOC, action: 'CREATE', source: 'web' }],
      so_scan_samples: [{ id: SAMPLE_ID, extracted: ai, corrected: null, status: over.sampleStatus ?? 'EXTRACTED' }],
      mfg_sales_orders: [over.header ?? soHeader()],
      mfg_sales_order_items: over.items ?? [soItem()],
    } as Record<string, Row[]>,
  };
}

describe('noteScanDraftAccepted — DRAFT -> CONFIRMED is the operator verdict', () => {
  test('confirmed AS-IS still lands ACCEPTED with corrected = extracted (unchanged behaviour)', async () => {
    const world = scanWorld();
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates.length).toBe(1);
    expect(updates[0].patch.status).toBe('ACCEPTED');
    expect(updates[0].patch.corrected).toBe(world.ai);
  });

  test('confirmed WITH EDITS lands CONFIRMED carrying the operator corrections', async () => {
    const world = scanWorld({
      audit: [
        { id: 1, so_doc_no: DOC, action: 'CREATE', source: 'web' },
        { id: 2, so_doc_no: DOC, action: 'UPDATE_LINE', source: 'web' },
      ],
      header: soHeader({ debtor_name: 'Tan Ah Kaw' }),
      items: [soItem({ item_code: 'BC-KING-2026' })],
    });
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates.length).toBe(1);
    expect(updates[0].patch.status).toBe('CONFIRMED');
    const corrected = updates[0].patch.corrected as Row;
    expect(corrected.customerName).toBe('Tan Ah Kaw');
    expect((corrected.lines as Row[])[0].skuMatch.code).toBe('BC-KING-2026');
    expect(JSON.stringify(corrected)).not.toBe(JSON.stringify(world.ai));
  });

  test('an audit row the pipeline itself wrote is not an operator edit', async () => {
    const world = scanWorld({
      audit: [
        { id: 1, so_doc_no: DOC, action: 'CREATE', source: 'web' },
        { id: 2, so_doc_no: DOC, action: 'ADD_PAYMENT', source: 'automation' },
        { id: 3, so_doc_no: DOC, action: 'UPDATE_STATUS', source: 'web' },
      ],
    });
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates[0].patch.status).toBe('ACCEPTED');
  });

  test('an audit row with UNKNOWN provenance counts as an edit', async () => {
    const world = scanWorld({
      audit: [{ id: 2, so_doc_no: DOC, action: 'UPDATE_DETAILS', source: null }],
      header: soHeader({ city: 'Kulai' }),
    });
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates[0].patch.status).toBe('CONFIRMED');
  });

  test('an edit that moved nothing the OCR emits writes NOTHING (no zero-diff pair)', async () => {
    const world = scanWorld({
      audit: [{ id: 2, so_doc_no: DOC, action: 'UPDATE_DETAILS', source: 'web' }],
    });
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates.length).toBe(0);
  });

  test('an SO that did not come from a scan is a no-op', async () => {
    const world = scanWorld();
    world.tables.scan_jobs = [];
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates.length).toBe(0);
  });

  test('a sample already reviewed is never rewritten (re-confirm counts once)', async () => {
    const world = scanWorld({ sampleStatus: 'CONFIRMED' });
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates.length).toBe(0);
  });

  test('a failing database never costs the operator their confirm', async () => {
    const world = scanWorld();
    const { svc, updates } = fakeSvc(world.tables, { throwOn: 'so_scan_samples' });
    await expect(noteScanDraftAccepted(svc, DOC)).resolves.toBeUndefined();
    expect(updates.length).toBe(0);
  });
});


const rawSlip = (): Row => extractedSlip({
  phones: ['012-694 5676'], city: 'shah alam', postcode: '40460',
  depositRm: 1500, deliveryDate: 'before 20/12',
  addressStateMatch: { value: 'Selangor', confidence: 0.9, reason: 'read' },
});
const pipelineHeader = (over: Row = {}): Row => soHeader({
  phone: '+60126945676', city: 'Shah Alam', postcode: '40470', customer_state: 'Selangor',
  deposit_sen: 0, customer_delivery_date: null, ...over,
});
const baselineOf = (raw: Row): Row => buildCorrectedSlipFromSo(raw, pipelineHeader(), [soItem()]) as Row;
const finalOf = (raw: Row, header: Row, items: Row[] = [soItem()]): Row =>
  buildCorrectedSlipFromSo(raw, header, items) as Row;

describe('keepPersonChanges — pipeline transforms are not corrections', () => {
  test('a draft only given a fair pick has no difference from the raw read', () => {
    const raw = rawSlip();
    const kept = keepPersonChanges(raw, baselineOf(raw), finalOf(raw, pipelineHeader()));
    expect(changedFields(raw, kept)).toEqual([]);
  });

  test('pipeline-only differences (phone format, postcode, city, withheld deposit) give no difference', () => {
    const raw = rawSlip();
    expect(changedFields(raw, baselineOf(raw))).toEqual(expect.arrayContaining(['Phone', 'Postcode', 'Deposit']));
    const kept = keepPersonChanges(raw, baselineOf(raw), baselineOf(raw));
    expect(changedFields(raw, kept)).toEqual([]);
  });

  test('a real phone digit change gives exactly Phone', () => {
    const raw = rawSlip();
    const kept = keepPersonChanges(raw, baselineOf(raw), finalOf(raw, pipelineHeader({ phone: '+60126945677' })));
    expect(changedFields(raw, kept)).toEqual(['Phone']);
  });

  test('a bedframe line change gives exactly that line field', () => {
    const raw = rawSlip();
    const kept = keepPersonChanges(raw, baselineOf(raw), finalOf(raw, pipelineHeader(), [soItem({ item_code: 'BC-Q' })]));
    expect(changedFields(raw, kept)).toEqual(['Product code']);
    expect(((kept.lines as Row[])[0].skuMatch as Row).code).toBe('BC-Q');
  });

  test('a delivery date filled from text the slip did not carry as a date is not a correction', () => {
    const raw = rawSlip();
    const kept = keepPersonChanges(raw, baselineOf(raw), finalOf(raw, pipelineHeader({ customer_delivery_date: '2026-12-20' })));
    expect(changedFields(raw, kept)).toEqual([]);
  });

  test('inputs are not mutated', () => {
    const raw = rawSlip();
    const baseline = baselineOf(raw);
    const final = finalOf(raw, pipelineHeader({ phone: '+60126945677' }));
    const snapshot = JSON.stringify([raw, baseline, final]);
    keepPersonChanges(raw, baseline, final);
    expect(JSON.stringify([raw, baseline, final])).toBe(snapshot);
  });
});

describe('noteScanDraftAccepted — with a draft baseline', () => {
  const baselineWorld = (header: Row) => {
    const raw = rawSlip();
    const world = scanWorld({
      audit: [
        { id: 1, so_doc_no: DOC, action: 'CREATE', source: 'web' },
        { id: 2, so_doc_no: DOC, action: 'UPDATE_HEADER', source: 'web' },
      ],
      header,
    });
    Object.assign(world.tables.so_scan_samples[0], { extracted: raw, draft_baseline: baselineOf(raw) });
    return { raw, world };
  };

  test('a fair pick only lands ACCEPTED with corrected = extracted', async () => {
    const { raw, world } = baselineWorld(pipelineHeader());
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates[0].patch.status).toBe('ACCEPTED');
    expect(updates[0].patch.corrected).toBe(raw);
  });

  test('a real phone change lands CONFIRMED with only the phone moved', async () => {
    const { raw, world } = baselineWorld(pipelineHeader({ phone: '+60126945677' }));
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates[0].patch.status).toBe('CONFIRMED');
    expect(changedFields(raw, updates[0].patch.corrected)).toEqual(['Phone']);
  });
});


const jsonbRoundTrip = (v: unknown): unknown => Array.isArray(v) ? v.map(jsonbRoundTrip) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>)
    .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => [k, jsonbRoundTrip(x)]))
  : v;

const slip2 = (over: Row = {}): Row => rawSlip2(over);
function rawSlip2(over: Row = {}): Row {
  return extractedSlip({
    phones: ['012-694 5676'], city: 'shah alam', postcode: '40460', depositRm: 1500, deliveryDate: 'before 20/12',
    addressStateMatch: { value: 'Selangor', confidence: 0.9, reason: 'read' },
    lines: [
      slipLine({ rawText: 'bed k', skuMatch: { code: 'bk-x', confidence: 0.6, reason: 'keyword' } }),
      slipLine({ rawText: 'pillow', skuMatch: { code: 'PL', confidence: 0.9, reason: 'keyword' } }),
    ],
    ...over,
  });
}
const itemsBedPillow = (): Row[] => [soItem({ item_code: 'BK', line_no: 0 }), soItem({ item_code: 'PL', line_no: 1 })];

describe('keepPersonChanges — reviewer cases', () => {
  test('a baseline that came back from jsonb with reordered keys, untouched draft: no difference', () => {
    const raw = slip2();
    const header = pipelineHeader();
    const baseline = jsonbRoundTrip(buildCorrectedSlipFromSo(raw, header, itemsBedPillow())) as Row;
    const final = buildCorrectedSlipFromSo(raw, header, itemsBedPillow()) as Row;
    expect(changedFields(raw, keepPersonChanges(raw, baseline, final))).toEqual([]);
  });

  test('delete one line and add another (same count): the added line has no slip provenance', () => {
    const raw = slip2();
    const baseline = buildCorrectedSlipFromSo(raw, pipelineHeader(), itemsBedPillow()) as Row;
    const final = buildCorrectedSlipFromSo(raw, pipelineHeader(), [
      soItem({ item_code: 'PL', line_no: 1 }), soItem({ item_code: 'MAT', line_no: 2 }),
    ]) as Row;
    const kept = keepPersonChanges(raw, baseline, final);
    const lines = kept.lines as Row[];
    const added = lines.find((l) => l.skuMatch?.code === 'MAT') as Row;
    expect(added.rawText).toBe('');
    expect(lines.some((l) => l.rawText === 'bed k')).toBe(false);
    expect(changedFields(raw, kept)).toContain('Product code');
  });

  test('a blank raw line the pipeline dropped, untouched draft: no difference', () => {
    const raw = slip2({ lines: [slipLine({ rawText: '', skuMatch: null }), ...(slip2().lines as Row[])] });
    const items = itemsBedPillow();
    const baseline = buildCorrectedSlipFromSo(raw, pipelineHeader(), items) as Row;
    const final = buildCorrectedSlipFromSo(raw, pipelineHeader(), items) as Row;
    const kept = keepPersonChanges(raw, baseline, final);
    expect(changedFields(raw, kept)).toEqual([]);
    expect(kept.lines).toBe(raw.lines);
  });

  test('a blank raw line plus one real line edit reports only that line field', () => {
    const raw = slip2({ lines: [slipLine({ rawText: '', skuMatch: null }), slipLine({ rawText: 'bed k', skuMatch: { code: 'BK', confidence: 0.9, reason: 'keyword' } }), slipLine({ rawText: 'pillow', skuMatch: { code: 'PL', confidence: 0.9, reason: 'keyword' } })] });
    const baseline = buildCorrectedSlipFromSo(raw, pipelineHeader(), itemsBedPillow()) as Row;
    const final = buildCorrectedSlipFromSo(raw, pipelineHeader(), [soItem({ item_code: 'BK', line_no: 0 }), soItem({ item_code: 'PL', qty: 2, line_no: 1 })]) as Row;
    expect(changedFields(raw, keepPersonChanges(raw, baseline, final))).toEqual(['Qty']);
  });
});

describe('noteScanDraftAccepted — baseline from jsonb, snapped values untouched', () => {
  test('geocoded state and snapped SKU untouched: ACCEPTED and no alias recorded', async () => {
    const raw = slip2();
    const world = scanWorld({ header: pipelineHeader(), items: itemsBedPillow(), audit: [
      { id: 1, so_doc_no: DOC, action: 'CREATE', source: 'web' },
      { id: 2, so_doc_no: DOC, action: 'UPDATE_HEADER', source: 'web' },
    ] });
    world.tables.mfg_sales_orders[0].customer_state = 'Johor';
    Object.assign(world.tables.so_scan_samples[0], {
      extracted: raw,
      draft_baseline: jsonbRoundTrip(buildCorrectedSlipFromSo(raw, world.tables.mfg_sales_orders[0], itemsBedPillow())),
    });
    const { svc, updates } = fakeSvc(world.tables);
    await noteScanDraftAccepted(svc, DOC);
    expect(updates.map((u) => u.table)).toEqual(['so_scan_samples']);
    expect(updates[0].patch.status).toBe('ACCEPTED');
  });
});

describe('snapshotDraftBaseline', () => {
  const stub = (headerError: boolean) => {
    const writes: Row[] = [];
    const svc = {
      from: (table: string) => {
        const q: Row = {
          select: () => q, eq: () => q, order: () => q,
          update: (patch: Row) => { writes.push({ table, patch }); return q; },
          maybeSingle: () => Promise.resolve(headerError
            ? { data: null, error: { message: 'boom' } }
            : { data: pipelineHeader({ company_id: 1 }), error: null }),
          then: (res: (v: Row) => unknown) => Promise.resolve(
            table === 'mfg_sales_order_items' ? { data: itemsBedPillow(), error: null } : { data: null, error: null },
          ).then(res),
        };
        return q;
      },
    };
    return { svc: svc as never, writes };
  };

  test('a header read error writes nothing and logs with the sample and doc', async () => {
    const { svc, writes } = stub(true);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await snapshotDraftBaseline(svc, { sampleId: SAMPLE_ID, docNo: DOC, extracted: slip2() });
    expect(writes).toEqual([]);
    expect(spy).toHaveBeenCalledWith(expect.any(String), { sampleId: SAMPLE_ID, docNo: DOC }, 'boom');
    spy.mockRestore();
  });

  test('the happy path writes the baseline built from the draft', async () => {
    const { svc, writes } = stub(false);
    const raw = slip2();
    await snapshotDraftBaseline(svc, { sampleId: SAMPLE_ID, docNo: DOC, extracted: raw });
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('so_scan_samples');
    expect(writes[0].patch.draft_baseline).toEqual(buildCorrectedSlipFromSo(raw, pipelineHeader({ company_id: 1 }), itemsBedPillow()));
  });
});

describe('keepPersonChanges — blank raw line plus a catalog-snapped SKU line', () => {
  test('a qty edit on another line gives exactly Qty and no alias for the snapped line', () => {
    const blank = slipLine({ rawText: '', skuMatch: null });
    const snapped = slipLine({ rawText: 'bed k', skuMatch: { code: 'bk-x', confidence: 0.6, reason: 'keyword' } });
    const pillow = slipLine({ rawText: 'pillow', skuMatch: { code: 'PL', confidence: 0.9, reason: 'keyword' } });
    const raw = slip2({ lines: [blank, snapped, pillow] });
    const stripped = { ...raw, lines: [snapped, pillow] };
    const baseline = buildCorrectedSlipFromSo(stripped, pipelineHeader(), itemsBedPillow()) as Row;
    const final = buildCorrectedSlipFromSo(stripped, pipelineHeader(), [
      soItem({ item_code: 'BK', line_no: 0 }), soItem({ item_code: 'PL', qty: 2, line_no: 1 }),
    ]) as Row;
    const kept = keepPersonChanges(raw, baseline, final);
    expect(changedFields(raw, kept)).toEqual(['Qty']);
    expect(JSON.stringify(slipAliasPairs(raw, kept))).not.toContain('bk-x');
  });
});
