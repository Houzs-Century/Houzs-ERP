import { describe, expect, it } from 'vitest';
import { deliveryIssueDraftError, deliveryIssueSummary, issuesForRow, runKeysOf, serviceCaseHref, type DeliveryIssue } from './delivery-issue-queries';

const issue = (p: Partial<DeliveryIssue>): DeliveryIssue => ({
  id: 'i', delivery_order_id: null, do_number: null, so_doc_no: null, source_type: null, source_id: null, leg: null,
  kinds: ['damaged'], note: null, photo_keys: [], assr_case_id: null, assr_no: null, reported_by: null, reported_at: '2026-11-09T02:00:00Z', ...p,
});

describe('delivery issue logic', () => {
  it('a draft needs a problem, and Other needs a note', () => {
    expect(deliveryIssueDraftError({ kinds: [], note: '', photos: [] })).toBe('Tick at least one problem.');
    expect(deliveryIssueDraftError({ kinds: ['other'], note: ' ', photos: [] })).toMatch(/Other/);
    expect(deliveryIssueDraftError({ kinds: ['damaged'], note: '', photos: [] })).toBeNull();
  });
  it('names the problems in words and links the case', () => {
    expect(deliveryIssueSummary({ kinds: ['damaged', 'customer_refused'] })).toBe('Damaged, Customer refused part');
    expect(serviceCaseHref({ assr_case_id: 77 })).toBe('/assr/77');
    expect(serviceCaseHref({ assr_case_id: null })).toBeNull();
  });
  it('a Last Mile SO row shows only its own DO\'s issues; a job row its job\'s', () => {
    const all = [
      issue({ id: 'a', delivery_order_id: 'd1', do_number: 'DO-1', so_doc_no: 'SO-1' }),
      issue({ id: 'b', delivery_order_id: 'd2', do_number: 'DO-2', so_doc_no: 'SO-1' }),
      issue({ id: 'c', source_type: 'assr', source_id: '12', leg: 'delivery', so_doc_no: 'SO-1' }),
    ];
    expect(issuesForRow(all, { rowType: 'so', soDocNo: 'SO-1', doNumber: 'DO-2', jobKey: null }).map((i) => i.id)).toEqual(['b']);
    expect(issuesForRow(all, { rowType: 'so', soDocNo: 'SO-1', doNumber: null, jobKey: null }).map((i) => i.id)).toEqual(['a', 'b']);
    expect(issuesForRow(all, { rowType: 'assr', soDocNo: 'ASSR:12', doNumber: null, jobKey: 'assr:12:delivery' }).map((i) => i.id)).toEqual(['c']);
    expect(runKeysOf([
      { rowType: 'so', soDocNo: 'SO-1', doNumber: 'DO-2', jobKey: null },
      { rowType: 'assr', soDocNo: 'ASSR:12', doNumber: null, jobKey: 'assr:12:delivery' },
    ])).toEqual({ so: ['SO-1'], jobs: ['assr:12:delivery'] });
  });
});
