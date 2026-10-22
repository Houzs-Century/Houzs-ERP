/* Scanning a supplier's credit note (owner 2026-10-01: supplier 给我 cn，我要做 ocr
   for cn；这个 cn 可能会 link 去相对应的 supplier invoice; the accounts: sponsorship
   and sales rebate → 591-0000, discount received → 610-0001). Pinned on the
   three Diglant notes the owner sent:
     • the reader's answer is coerced to sen; the invoices it names are listed
       once, from the header and the lines; a non-credit-note is said;
     • the account comes from the line's words, then the note's remark;
     • a printed SST is spread over the lines (the purchase was booked with it);
     • one supplier invoice keyed as three purchase invoices: each line goes to
       the one whose items share its words — PI-017's Equinox K;
     • the scan answers the supplier, the lines, the invoices with what is still
       owed, the suggested document, the same CN recorded before; nothing is
       written; its refusals;
     • a supplier note credits only its own supplier's invoice; the list and
       the detail name it;
     • the note keeps its paper: attach while DRAFT, kept once POSTED, none on a
       CANCELLED note. */

import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { creditNotes } from '../src/scm/routes/credit-notes';
import { coerceCnJson } from '../src/acc/cn-extract';
import { pickCreditedDocs, scnAccountFor, spreadToTotal, type PurchaseDoc } from '../src/scm/lib/scn-scan';

const CO = 1;
const KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

/* The three notes as the reader answers them. */
const DISPLAY = {
  isCreditNote: true, vendorName: 'DIGLANT MANUFACTURING SDN. BHD.', vendorRegNo: '1459872-U', cnNumber: 'DGPSC26000263', cnDate: '2026-09-07',
  invoiceNumbers: ['DGSIZ26001811'], subtotalRm: 590.91, sstRm: 59.09, totalRm: 650, remark: '25% display discount',
  lines: [
    { description: 'Mattress Akemi Medi+Health Equinox K — Selangor Akemi Solo @ Aeon Big Puchong 15-19/7/26', invoiceNo: 'DGSIZ26001811', itemCode: 'T1MAMJA0MK', qty: 1, unitPriceRm: 295.45, amountRm: 295.45 },
    { description: 'Mattress Akemi Medi+Health Equinox K — KL Akemi Perfect Living @ Mid Valley 14-16/8/2026', invoiceNo: 'DGSIZ26001811', itemCode: 'T1MAMJA0MK', qty: 1, unitPriceRm: 295.46, amountRm: 295.46 },
  ],
};
const REBATE = {
  isCreditNote: true, vendorName: 'DIGLANT MANUFACTURING SDN. BHD.', vendorRegNo: '1459872-U', cnNumber: 'DGPSC26000280', cnDate: '2026-09-21',
  invoiceNumbers: [], subtotalRm: 28622.37, sstRm: 0, totalRm: 28622.37, remark: null,
  lines: [{ description: "Sales Rebate - Aug'26", invoiceNo: null, itemCode: null, qty: 1, unitPriceRm: 28622.37, amountRm: 28622.37 }],
};
const SPONSOR = {
  isCreditNote: true, vendorName: 'DIGLANT MANUFACTURING SDN. BHD.', vendorRegNo: '1459872-U', cnNumber: 'DGPSC26000281', cnDate: '2026-09-21',
  invoiceNumbers: [], subtotalRm: 82569.68, sstRm: 0, totalRm: 82569.68, remark: null,
  lines: [{ description: "Booth Rental Sponsor - Aug'26", invoiceNo: null, itemCode: null, qty: 1, unitPriceRm: 82569.68, amountRm: 82569.68 }],
};

/* One supplier invoice, keyed in the ERP as three purchase invoices (as on production). */
const PI = (id: string, number: string, total: number): Row => ({
  id, company_id: CO, invoice_number: number, supplier_id: 'sup-d', supplier_invoice_ref: 'DGSIZ26001811', invoice_date: '2026-09-07', total_sen: total, paid_sen: 0, status: 'POSTED',
});
const ITEM = (pi: string, code: string, name: string): Row => ({ id: `it-${pi}-${code}`, company_id: CO, purchase_invoice_id: pi, item_code: code, material_name: name, description: null });

describe('the paper, read', () => {
  test('amounts in sen; the invoices named once, from the header and the lines; a non-credit-note is said; garbage is safe', () => {
    const ex = coerceCnJson({ ...DISPLAY, invoiceNumbers: [] });
    expect(ex.cnNumber).toBe('DGPSC26000263');
    expect(ex.cnDate).toBe('2026-09-07');
    expect([ex.subtotalSen, ex.sstSen, ex.totalSen]).toEqual([59_091, 5_909, 65_000]);
    expect(ex.lines.map((l) => [l.itemCode, l.unitPriceSen, l.amountSen])).toEqual([['T1MAMJA0MK', 29_545, 29_545], ['T1MAMJA0MK', 29_546, 29_546]]);
    expect(ex.invoiceNumbers).toEqual(['DGSIZ26001811']);
    expect(coerceCnJson({ ...REBATE, isCreditNote: false }).isCreditNote).toBe(false);
    const junk = coerceCnJson({ lines: [null, 3, { amountRm: 'x' }], totalRm: 'abc', cnDate: '21/09/2026' });
    expect([junk.totalSen, junk.cnDate, junk.lines.length]).toEqual([null, null, 0]);
  });

  test('the account: the line\'s words, then the note\'s remark — rebate and sponsorship 591-0000, a discount 610-0001', () => {
    expect(scnAccountFor("Sales Rebate - Aug'26", null)).toEqual({ code: '591-0000', label: 'sales rebate' });
    expect(scnAccountFor("Booth Rental Sponsor - Aug'26", null)).toEqual({ code: '591-0000', label: 'sponsorship' });
    expect(scnAccountFor('Mattress Akemi Medi+Health Equinox K', '25% display discount')).toEqual({ code: '610-0001', label: 'discount received' });
    expect(scnAccountFor('Returned bedframe', null)).toBeNull();
  });

  test('a printed SST is spread over the lines, the last taking the rounding; no total or the same total leaves them', () => {
    /* In proportion: 295.45 and 295.46 grow to 324.99 and 325.01, adding to the printed 650.00. */
    expect(spreadToTotal([29_545, 29_546], 65_000)).toEqual([32_499, 32_501]);
    expect(spreadToTotal([10_000, 10_000, 10_000], 33_334)).toEqual([11_111, 11_111, 11_112]);
    expect(spreadToTotal([2_862_237], 2_862_237)).toEqual([2_862_237]);
    expect(spreadToTotal([500], null)).toEqual([500]);
  });

  test('one supplier invoice as three purchase invoices: each line goes to the one whose items share its words', () => {
    const doc = (id: string, items: string[]): PurchaseDoc => ({ kind: 'PI', id, number: id, invoiceRef: 'DGSIZ26001811', invoiceDate: null, totalSen: 1, paidSen: 0, status: 'POSTED', itemTexts: items });
    const docs = [
      doc('pi-17', ['AKEMI EQUINOX MATT (K) AKEMI EQUINOX MATTRESS (183x190x30CM)']),
      doc('pi-18', ['AKEMI IMMORTAL MATT (Q) AKEMI IMMORTAL MATTRESS (153x190x36CM)']),
      doc('pi-19', ['AK-SK + MICROFIL PIL AKE MEDI+HEALTH SKIN + MICROFIL PILLOW']),
    ];
    const lines = DISPLAY.lines.map((l) => ({ text: `${l.itemCode} ${l.description}`, invoiceNo: l.invoiceNo }));
    const picked = pickCreditedDocs(lines, docs, ['DGSIZ26001811']);
    expect(picked.perLine).toEqual(['pi-17', 'pi-17']);
    expect(picked.suggested?.id).toBe('pi-17');
    expect(pickCreditedDocs([{ text: "Sales Rebate - Aug'26", invoiceNo: null }], docs, [])).toEqual({ perLine: [null], suggested: null });
  });
});

const anthropicAnswer = (body: unknown) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }] }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); });

const fakeR2 = () => {
  const store = new Map<string, { bytes: ArrayBuffer; contentType: string }>();
  return {
    store,
    put: async (k: string, v: ArrayBuffer, o?: { httpMetadata?: { contentType?: string } }) => { store.set(k, { bytes: v, contentType: o?.httpMetadata?.contentType ?? '' }); },
    get: async (k: string) => { const hit = store.get(k); return hit ? { body: new Blob([hit.bytes]).stream(), httpMetadata: { contentType: hit.contentType } } : null; },
    delete: async (k: string) => { store.delete(k); },
  };
};

function harness(perms: readonly string[] = KEYS, existing: Row[] = []) {
  const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
    company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
  });
  const sb = fakeSb({
    accounts: [
      acct('400-0000', 'ACCOUNT PAYABLE', 'LIABILITY', { special_type: 'SCC' }),
      acct('591-0000', 'SPONSORSHIP', 'INCOME'),
      acct('610-0001', 'DISCOUNT RECEIVED', 'EXPENSE'),
      acct('612-0000', 'PURCHASES RETURN', 'EXPENSE'),
    ],
    suppliers: [
      { id: 'sup-d', company_id: CO, code: '400-D002', name: 'DIGLANT MANUFACTURING SDN BHD.', status: 'ACTIVE' },
      { id: 'sup-g', company_id: CO, code: '400-G005', name: 'GUANGDONG DIGLANT FURNITURE INDUSTRIAL CO.LTD', status: 'ACTIVE' },
    ],
    purchase_invoices: [PI('pi-17', 'HC-PI-2610-017', 260_000), PI('pi-18', 'HC-PI-2610-018', 130_000), PI('pi-19', 'HC-PI-2610-019', 170_600),
      { ...PI('pi-g', 'HC-PI-2610-099', 50_000), supplier_id: 'sup-g', supplier_invoice_ref: 'G-1' }],
    purchase_invoice_items: [
      ITEM('pi-17', 'AKEMI EQUINOX MATT (K)', 'AKEMI EQUINOX MATTRESS (183x190x30CM)'), ITEM('pi-17', 'AKEMI EQUINOX MATT (K) ', 'AKEMI EQUINOX MATTRESS (183x190x30CM)'),
      ITEM('pi-18', 'AKEMI IMMORTAL MATT (Q)', 'AKEMI IMMORTAL MATTRESS (153x190x36CM)'),
      ITEM('pi-19', 'AK-SK + MICROFIL PIL', 'AKE MEDI+HEALTH SKIN + MICROFIL PILLOW'),
    ],
    ap_invoices: [], ap_invoice_lines: [],
    acc_account_roles: [],
    acc_credit_notes: existing.map((r) => ({ ...r })), acc_credit_note_lines: [], acc_credit_note_files: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines']);
  const r2 = fakeR2();
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS' }] as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    await next();
  });
  app.route('/credit-notes', creditNotes);
  const req = (path: string, method: string, body?: unknown, env: Row = { ANTHROPIC_API_KEY: 'k', SLIPS: r2 }) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env as never);
  return { req, sb, r2 };
}

const PAGE = { files: [{ name: 'cn.pdf', mime: 'application/pdf', dataBase64: 'JVBERi0=' }] };
type Scan = {
  supplier: Row | null; lines: Row[]; invoices: Row[]; suggested: Row | null; duplicates: Row[]; notes: string[]; read: Row;
};

describe('POST /credit-notes/scan', () => {
  test('the display discount: Diglant, two lines on 610-0001 grown by the SST to RM 650.00, the three purchase invoices with what is owed, PI-017 suggested', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(DISPLAY)));
    const { req } = harness();
    const res = await req('/credit-notes/scan', 'POST', PAGE);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as Scan;
    expect(body.supplier).toMatchObject({ id: 'sup-d', code: '400-D002', confidence: 'exact' });
    expect(body.lines.map((l) => [l.amountSen, l.accountCode, l.rule, l.creditsDocId])).toEqual([[32_499, '610-0001', 'discount received', 'pi-17'], [32_501, '610-0001', 'discount received', 'pi-17']]);
    expect(body.lines[0]!.description).toMatch(/^Mattress Akemi Medi\+Health Equinox K — Selangor Akemi Solo @ Aeon Big Puchong 15-19\/7\/26 · inv\. DGSIZ26001811$/);
    expect(body.invoices.map((d) => [d.number, d.outstandingSen])).toEqual([['HC-PI-2610-017', 260_000], ['HC-PI-2610-018', 130_000], ['HC-PI-2610-019', 170_600]]);
    expect(body.suggested).toEqual({ kind: 'PI', id: 'pi-17', number: 'HC-PI-2610-017' });
    expect(body.notes).toEqual(['SST RM 59.09 is spread over the lines — the purchase was booked with its SST.']);
    expect(body.duplicates).toEqual([]);
    /* Nothing written: the list is still empty. */
    expect(((await (await req('/credit-notes', 'GET')).json()) as { rows: Row[] }).rows).toEqual([]);
  });

  test('the rebate and the sponsorship land on 591-0000; the same CN recorded before is said, never blocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(REBATE)));
    const { req } = harness(KEYS, [{ id: 'n-old', company_id: CO, note_number: 'HC-SCN-2609-001', kind: 'SCN', supplier_id: 'sup-d', source_doc_no: 'DGPSC26000280', status: 'POSTED' }]);
    const rebate = await (await req('/credit-notes/scan', 'POST', PAGE)).json() as Scan;
    expect(rebate.lines.map((l) => [l.amountSen, l.accountCode, l.accountName])).toEqual([[2_862_237, '591-0000', 'SPONSORSHIP']]);
    expect(rebate.suggested).toBeNull();
    expect(rebate.duplicates).toEqual([{ noteNumber: 'HC-SCN-2609-001', status: 'POSTED' }]);
    expect(rebate.notes).toEqual(['DGPSC26000280 is already recorded as HC-SCN-2609-001 (posted).']);

    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer(SPONSOR)));
    const sponsor = await (await req('/credit-notes/scan', 'POST', PAGE)).json() as Scan;
    expect(sponsor.lines.map((l) => [l.amountSen, l.accountCode, l.rule])).toEqual([[8_256_968, '591-0000', 'sponsorship']]);
  });

  test('an unknown issuer, a paper that is not a credit note, an invoice not here — each said', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => anthropicAnswer({ ...DISPLAY, isCreditNote: false, vendorName: 'SOMEBODY ELSE SDN BHD' })));
    const { req } = harness();
    const body = await (await req('/credit-notes/scan', 'POST', PAGE)).json() as Scan;
    expect(body.supplier).toBeNull();
    expect(body.invoices).toEqual([]);
    expect(body.notes.slice(0, 2)).toEqual([
      'This paper does not read as a credit note — check it before saving.',
      'The issuer "SOMEBODY ELSE SDN BHD" is not one of the suppliers here — pick the supplier.',
    ]);
  });

  test('refusals: the key, the reader\'s key, no files, a wrong file type, the reader failing', async () => {
    expect((await harness([]).req('/credit-notes/scan', 'POST', PAGE)).status).toBe(403);
    expect((await harness().req('/credit-notes/scan', 'POST', PAGE, {})).status).toBe(503);
    expect((await harness().req('/credit-notes/scan', 'POST', { files: [] })).status).toBe(400);
    const bad = await harness().req('/credit-notes/scan', 'POST', { files: [{ name: 'a.docx', mime: 'application/msword', dataBase64: 'aGk=' }] });
    expect([bad.status, (await bad.json() as Row).error]).toEqual([400, 'bad_file_type']);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('overloaded', { status: 529 })));
    const failed = await harness().req('/credit-notes/scan', 'POST', PAGE);
    expect([failed.status, (await failed.json() as Row).error]).toEqual([502, 'read_failed']);
  });
});

describe('the note credits its own supplier\'s invoice, and keeps its paper', () => {
  const SCN = { kind: 'SCN', supplierId: 'sup-d', noteDate: '2026-09-07', sourceDocNo: 'DGPSC26000263', reason: '25% display discount', lines: [{ description: 'Equinox K display', accountCode: '610-0001', amountSen: 65_000 }] };

  test('another supplier\'s invoice is refused; its own is kept and named by the list and the detail; a customer note may not name one', async () => {
    const { req } = harness();
    const other = await req('/credit-notes', 'POST', { ...SCN, purchaseInvoiceId: 'pi-g' });
    expect([other.status, (await other.json() as Row).error]).toEqual([400, 'invoice_not_this_supplier']);
    const own = await req('/credit-notes', 'POST', { ...SCN, purchaseInvoiceId: 'pi-17' });
    expect(own.status, await own.clone().text()).toBe(201);
    const id = (await own.json() as { note: Row }).note.id as string;
    const detail = await (await req(`/credit-notes/${id}`, 'GET')).json() as { note: Row };
    expect([detail.note.purchase_invoice_id, detail.note.purchase_invoice_number, detail.note.source_doc_no]).toEqual(['pi-17', 'HC-PI-2610-017', 'DGPSC26000263']);
    const list = await (await req('/credit-notes', 'GET')).json() as { rows: Row[] };
    expect(list.rows[0]!.purchase_invoice_number).toBe('HC-PI-2610-017');
    const cn = await req('/credit-notes', 'POST', { kind: 'CN', partyName: 'Walk-in', lines: [{ amountSen: 100 }], purchaseInvoiceId: 'pi-17' });
    expect([cn.status, (await cn.json() as Row).error]).toEqual([400, 'invoice_not_this_kind']);
  });

  test('the scanned paper attaches while DRAFT, stays once POSTED, and a CANCELLED note takes no more', async () => {
    const { req, r2 } = harness();
    const id = ((await (await req('/credit-notes', 'POST', SCN)).json()) as { note: Row }).note.id as string;
    const up = await req(`/credit-notes/${id}/files`, 'POST', { fileName: 'DGPSC26000263.pdf', mime: 'application/pdf', dataBase64: btoa('PDFBYTES') });
    expect(up.status, await up.clone().text()).toBe(201);
    expect([...r2.store.keys()].every((k) => k.startsWith(`credit-note-files/${CO}/${id}/`))).toBe(true);
    const files = (await (await req(`/credit-notes/${id}/files`, 'GET')).json() as { files: Row[] }).files;
    expect(files.map((f) => f.file_name)).toEqual(['DGPSC26000263.pdf']);

    expect((await req(`/credit-notes/${id}/post`, 'POST')).status).toBe(200);
    const del = await req(`/credit-notes/${id}/files/${files[0]!.id}`, 'DELETE');
    expect([del.status, (await del.json() as Row).error]).toEqual([409, 'evidence_locked']);

    expect((await req(`/credit-notes/${id}/cancel`, 'POST')).status).toBe(200);
    const late = await req(`/credit-notes/${id}/files`, 'POST', { fileName: 'late.pdf', mime: 'application/pdf', dataBase64: btoa('X') });
    expect([late.status, (await late.json() as Row).error]).toEqual([409, 'note_cancelled']);
  });
});
