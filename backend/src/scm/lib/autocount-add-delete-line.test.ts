/* The two line-shape operations an operator performs in ONE save — DELETE a line
 * and ADD another — asserted together.
 *
 * Its own file because `autocount-outbox.test.ts` already sits over the
 * 2,000-line cap and a ceiling only moves down (docs/repo-hygiene.md).
 *
 * WHY IT EXISTS. Owner, 2026-08-31, about HC-SO-013394: 「是因为我删了一行，然后
 * 加了一行，所以导致这样子」. That is a hypothesis, and a hypothesis is worth a test
 * rather than an argument — it is REFUTED here, both halves travel. The real
 * cause was the added line's key never coming back (docs/bugs/0583-*), pinned in
 * autocount-drain.test.ts.
 *
 * The two halves are computed on different paths over the same payload —
 * `retired` is appended after the retained lines, `IsNewLine` is stamped during
 * the keyless walk — so if this ever goes red, the COMBINATION is the fault, and
 * saying so is what this file is for.
 */
import { describe, expect, test } from 'vitest';
import { enqueueEdit } from './autocount-outbox';
import { fakeSb, type Row } from './fake-postgrest';

const ERP_A = 'AKEMI APEX MATT (SP)';
const ERP_B = 'AKEMI ARISTOI MATT (SP)';
const AC_B = 'AK-ARISTOI MATT (SP)';

const withFlag = (extra: Record<string, Row[]>) => fakeSb({
  app_config: [{ key: 'scm.autocount_writeback', value: '1' }],
  autocount_outbox: [],
  staff: [{ id: 'staff-1', name: 'Nurul Hidayah' }],
  ...extra,
});

describe('one save that deletes a line and adds another', () => {
  test('both travel: the deleted line is retired and the added one is declared new', async () => {
    const sb = withFlag({
      mfg_sales_orders: [{
        doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null,
        salesperson_id: 'staff-1', sales_location: 'KL', branding: null, venue: null,
        address1: null, address2: null, address3: null, address4: null,
        phone: null, ref: null, po_doc_no: null, linked_ac_docno: 'SO-000021',
      }],
      mfg_sales_order_items: [
        { id: 'row-old', doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 991 },
        { id: 'row-new', doc_no: 'HC-SO-9', item_code: ERP_B, description: 'added', qty: 1, unit_price_sen: 200, linked_ac_dtlkey: null },
      ],
    });

    expect(await enqueueEdit(sb as never, {
      companyId: 1,
      docType: 'SO',
      docNo: 'HC-SO-9',
      newLineIds: ['row-new'],
      retire: [{ DtlKey: 4242, ItemCode: 'GONE-1' } as never],
    })).toBe(true);

    const lines = (sb.tables.autocount_outbox ?? [])[0].payload.body.Lines as Array<Record<string, unknown>>;
    expect(lines.find((l) => l.ItemCode === AC_B)?.IsNewLine).toBe(true);
    expect(lines.find((l) => Number(l.DtlKey) === 4242)?.Retire).toBe(true);
    expect(lines.find((l) => Number(l.DtlKey) === 991)?.IsNewLine).toBeUndefined();
  });
});

/* THE FOUR DOWNSTREAM DOCUMENTS, wired 2026-08-31 on the owner's word
   (「全部都做完」). The same contract, and the same guard: an undeclared keyless
   line still refuses the whole document, because guessing "new" appends a
   duplicate into a live account book. */
describe('a line added to a downstream document', () => {
  const docCase = {
    DO: {
      header: 'delivery_orders',
      items: 'delivery_order_items',
      fk: 'delivery_order_id',
      row: { id: 'do-1', do_number: 'HC-DO-9', do_date: '2026-08-10', debtor_name: 'ACME', ref: null, phone: null, note: null, linked_ac_docno: 'DO-000021' },
    },
  } as const;

  test('declared by the route: the added line goes as IsNewLine', async () => {
    const spec = docCase.DO;
    const sb = withFlag({
      [spec.header]: [{ ...spec.row }],
      [spec.items]: [
        { id: 'row-old', [spec.fk]: 'do-1', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 991, created_at: '2026-08-10T00:00:00Z' },
        { id: 'row-new', [spec.fk]: 'do-1', item_code: ERP_B, description: 'added', qty: 1, unit_price_sen: 200, linked_ac_dtlkey: null, created_at: '2026-08-10T01:00:00Z' },
      ],
    });

    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'DO', docId: 'do-1', newLineIds: ['row-new'],
    })).toBe(true);

    const lines = (sb.tables.autocount_outbox ?? [])[0].payload.body.Lines as Array<Record<string, unknown>>;
    expect(lines.find((l) => l.ItemCode === AC_B)?.IsNewLine).toBe(true);
    expect(lines.find((l) => Number(l.DtlKey) === 991)?.IsNewLine).toBeUndefined();
  });

  test('NOT declared: still refused, so a legacy keyless line is never appended twice', async () => {
    const spec = docCase.DO;
    const sb = withFlag({
      [spec.header]: [{ ...spec.row }],
      [spec.items]: [
        { id: 'row-old', [spec.fk]: 'do-1', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 991, created_at: '2026-08-10T00:00:00Z' },
        { id: 'row-new', [spec.fk]: 'do-1', item_code: ERP_B, description: 'added', qty: 1, unit_price_sen: 200, linked_ac_dtlkey: null, created_at: '2026-08-10T01:00:00Z' },
      ],
    });

    expect(await enqueueEdit(sb as never, { companyId: 1, docType: 'DO', docId: 'do-1' })).toBe(false);
    expect((sb.tables.autocount_outbox ?? [])[0].last_error).toContain('refused, nothing sent');
  });
});

/* THE LINE SET DECIDES — and it has to reach the PAYLOAD, not just be computed.
 *
 * Owner 2026-09-02: 「如果我们有 delete line、add line 导致了它的 line 不平整了，我们
 * 就整张重建」. `shouldRebuild` derives that correctly, and until these two tests
 * were written NOTHING carried the answer out of composeEdit unless the document
 * ALSO had an unmatchable line — so the ordinary case, deleting one line from a
 * fully-keyed document, went out as a plain keyed edit and the book kept the
 * line at Qty 0. That is the exact symptom docs/bugs/0606 opened with.
 */
describe('a changed line set reaches the payload', () => {
  const SO_HEADER = {
    doc_no: 'HC-SO-9', so_date: null, debtor_name: 'ACME', agent: null,
    salesperson_id: 'staff-1', sales_location: 'KL', branding: null, venue: null,
    address1: null, address2: null, address3: null, address4: null,
    phone: null, ref: null, po_doc_no: null, linked_ac_docno: 'SO-000021',
  };

  test('deleting a line rebuilds, even when every remaining line is keyed', async () => {
    const sb = withFlag({
      mfg_sales_orders: [{ ...SO_HEADER }],
      mfg_sales_order_items: [
        { id: 'row-keep', doc_no: 'HC-SO-9', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 991 },
      ],
    });

    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'SO', docNo: 'HC-SO-9',
      retire: [{ DtlKey: 992, ItemCode: AC_B, Gone: 'deleted' }],
    })).toBe(true);

    expect((sb.tables.autocount_outbox ?? [])[0].payload.body.Rebuild).toBe(true);
  });

  /* THE OTHER HALF, and it is the dangerous direction. A delivery order was
     CREATED BY TRANSFER, and its lines are where AutoCount records that -
     FromDocType / FromDocNo, listed in AcSyncService.DetailWanted with the note
     that these four are the DOWNSTREAM shape. ClearDetails() destroys them, and
     the host's own guard cannot see it: AnyLineTransferred reads TransferedQty,
     which is what this document transferred ONWARD, not what it came from. So
     the ERP must never ask. */
  test('a converted document is never rebuilt, whatever its line set did', async () => {
    const sb = withFlag({
      delivery_orders: [{ id: 'do-1', do_number: 'HC-DO-9', do_date: '2026-08-10', debtor_name: 'ACME', ref: null, phone: null, note: null, linked_ac_docno: 'DO-000021' }],
      delivery_order_items: [
        { id: 'row-keep', delivery_order_id: 'do-1', item_code: ERP_A, description: 'M', qty: 1, unit_price_sen: 100, linked_ac_dtlkey: 991, created_at: '2026-08-10T00:00:00Z' },
      ],
    });

    expect(await enqueueEdit(sb as never, {
      companyId: 1, docType: 'DO', docId: 'do-1',
      retire: [{ DtlKey: 992, ItemCode: AC_B, Gone: 'deleted' }],
    })).toBe(true);

    expect((sb.tables.autocount_outbox ?? [])[0].payload.body.Rebuild).toBeUndefined();
  });
});
