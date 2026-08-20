// Unit tests for the OCR self-learning feed on the BACKGROUND scan path.
//
// The behaviour being pinned: an EDITED scan-originated SO must now produce a
// LEARNABLE `CONFIRMED` sample (the pool every distiller mines — it was fed
// nothing at all before this), while an UNEDITED one must keep producing
// `ACCEPTED` exactly as it did. Route-level coverage is not possible in this
// repo's harness (scm rides Supabase Postgres, the harness rebuilds only the
// D1 side) and @cloudflare/vitest-pool-workers has no module mocking, so these
// drive the lib directly through a hand-rolled PostgREST stand-in — the house
// pattern (see dropship-batch.test.ts, companyScopeHardening.test.ts).
import { describe, expect, test } from 'vitest';
import {
  noteScanDraftAccepted,
  buildCorrectedSlipFromSo,
  alignSoLinesToSlip,
  CARRIED_NOT_INVERTED,
} from './scan-sample-review';

type Row = Record<string, any>;

/* Minimal chainable, awaitable PostgREST stand-in. `not` and `or` are
   IMPLEMENTED rather than no-op'd (unlike the other fakes in this repo)
   because the edit-detection predicate is the load-bearing bit here: it is
   what decides ACCEPTED vs CONFIRMED. */
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
        // '("CREATE","UPDATE_STATUS")' -> the excluded action names
        const list = String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
        this.preds.push((r) => !list.includes(String(r[c])));
      }
      return this;
    }
    or(expr: string) {
      // Only the one expression this module uses.
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

// ── Fixtures ───────────────────────────────────────────────────────────────

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

/** The SO exactly as buildDraftSoBodyFromSlip + the create core would leave it
 *  for the fixture above, with nothing touched by a human. */
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

// ── The pure rebuild ───────────────────────────────────────────────────────

describe('buildCorrectedSlipFromSo — an untouched SO must produce ZERO diff', () => {
  test('inverting an unedited SO returns the extraction byte-for-byte', () => {
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem()]);
    expect(JSON.stringify(out)).toBe(JSON.stringify(ai));
  });

  test('the create core repricing the line is NOT read back as a correction', () => {
    // The slip said RM1200; the pricing engine booked RM1390. priceRmGuess must
    // stay the AI's read, or the distiller learns a price the operator never wrote.
    const ai = extractedSlip();
    const out = buildCorrectedSlipFromSo(ai, soHeader(), [soItem({ unit_price_sen: 139000 })]);
    expect((out?.lines as Row[])[0].priceRmGuess).toBe(1200);
  });

  test('the venue autofill and the duplicate note prefix are NOT read back', () => {
    // Neither is inverted at all, so a value the pipeline invented cannot leak
    // into the pair. Pinned against the documented exclusion list.
    expect(CARRIED_NOT_INVERTED).toContain('locationMatch');
    expect(CARRIED_NOT_INVERTED).toContain('remarks');
    /* The SLIP'S OWN DATE. It is deliberately NOT inverted from the SO, because
       the SO's Processing Date (internal_expected_dd) is a DIFFERENT fact — the
       factory start date the operator keys at review. Both were once called
       "processingDate"; if this entry ever drifts back to that name, or drops
       out of the array, the inverter starts teaching the model to read the
       factory date off the slip's date line. */
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
    // This pairing IS the alias dictionary's raw material.
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
    // Unchanged option pick keeps the AI's own confidence/reason — no fake diff.
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
    // Method still Cash: merchant_provider is null for a forward-mapping reason,
    // so the AI's bank read must be carried, not "corrected" to null.
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
    // Two slip rows, one surviving item with a code matching neither: we cannot
    // know which row it came from, so no rawText is paired to it.
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

// ── The listener ───────────────────────────────────────────────────────────

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
    // CONFIRMED is the ONLY status the distillers select — this is the feed.
    expect(updates[0].patch.status).toBe('CONFIRMED');
    const corrected = updates[0].patch.corrected as Row;
    expect(corrected.customerName).toBe('Tan Ah Kaw');
    expect((corrected.lines as Row[])[0].skuMatch.code).toBe('BC-KING-2026');
    // …and it is a real, learnable DIFF, not a restatement of the extraction.
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
    // The operator changed the venue and the note only. Storing corrected =
    // extracted would evict a real correction from the distill window; storing
    // ACCEPTED would claim the AI was right about a draft a human just edited.
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
