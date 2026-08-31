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
