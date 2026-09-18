// What check-so-amendment-bound-po-reads.mjs CALLS each measured shape, and the
// byte count it rests on. The SQL is only runnable against a real database
// (tests-pg/soAmendmentBoundPoReadsSql.pg.test.ts); the sentences and the request
// sizes are not, and they are the part that can turn "nothing was measured" into a
// clean-looking pass.
import { describe, expect, it } from 'vitest';

import {
  ASSUMED_ROW_CEILING,
  CLOSED_STATUSES,
  LIST_WINDOW,
  REFUSED_URI_BYTES,
  URL_BUDGET_BYTES,
  assessCompany,
  assessScope,
  describeCompany,
  describeScope,
  measureRequestTargets,
  requestTargetBytes,
} from '../scripts/lib/so-amendment-bound-po-reads.mjs';
import { PAGE, URL_QUERY_BUDGET } from '../src/scm/lib/paginate-all';
import { amendmentBucketOf } from '../../frontend/src/vendor/scm/lib/status-pill.ts';

const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/* postgres returns COUNT(*) as strings, so the fixtures do too. */
const row = (o = {}) => ({
  company_id: '1',
  company_code: 'HOUZS',
  amendments_total: '40',
  created_last_30_days: '10',
  page_rows: '40',
  page_docs: '30',
  queue_rows: '12',
  queue_rows_requested: '5',
  page_rows_with_foreign_po: '0',
  line_rows: '90',
  lines_other_company: '0',
  max_lines_one_order: '6',
  po_line_rows: '60',
  po_rows: '20',
  pos_other_company: '0',
  doc_nos: [],
  item_ids: [],
  po_ids: [],
  ...o,
});
const small = { lines: 500, poLines: 900, pos: 700, reference: 520 };
const kinds = (a) => a.verdicts.map((v) => v.kind);

describe('the thresholds are the tree\'s own, not copies that can drift', () => {
  it('the row ceiling is paginate-all\'s PAGE and the budget is its URL_QUERY_BUDGET', () => {
    expect(ASSUMED_ROW_CEILING).toBe(PAGE);
    expect(URL_BUDGET_BYTES).toBe(URL_QUERY_BUDGET);
  });

  it('CLOSED_STATUSES is exactly what the queue\'s Requested chip leaves out', () => {
    const every = ['REQUESTED', 'SUPPLIER_PENDING', 'SO_APPROVED', 'PO_APPROVED', 'SENT', 'REJECTED', 'APPROVED'];
    for (const s of every) {
      expect(CLOSED_STATUSES.includes(s), s).toBe(amendmentBucketOf(s) !== 'REQUESTED');
    }
  });
});

describe('requestTargetBytes measures the real client\'s request line', () => {
  it('matches the URL supabase-js builds, byte for byte, on a list small enough to write out', async () => {
    const a = uuid(1);
    const b = uuid(2);
    const bytes = await requestTargetBytes((sb) =>
      sb.from('purchase_order_items').select('purchase_order_id, so_item_id').in('so_item_id', [a, b]));
    const expected = `/rest/v1/purchase_order_items?select=purchase_order_id%2Cso_item_id&so_item_id=in.%28${a}%2C${b}%29`;
    expect(bytes).toBe(expected.length);
  });

  it('each further uuid costs its 36 characters plus an encoded comma', async () => {
    const size = (count) => requestTargetBytes((sb) =>
      sb.from('purchase_order_items').select('purchase_order_id, so_item_id')
        .in('so_item_id', Array.from({ length: count }, (_, i) => uuid(i + 1))));
    expect((await size(101)) - (await size(100))).toBe(36 + '%2C'.length);
  });

  it('an unsent read is null, never 0, and the Reference read carries its company predicate', async () => {
    const empty = await measureRequestTargets(row());
    expect(empty).toEqual({ lines: null, poLines: null, pos: null, reference: null });

    const t = await measureRequestTargets(row({ doc_nos: ['HC-SO-000001'], item_ids: [uuid(1)], po_ids: [uuid(2)] }));
    expect(t.lines).toBeGreaterThan(0);
    expect(t.poLines).toBeGreaterThan(0);
    expect(t.pos).toBeGreaterThan(0);
    // Same SO-number list as read A, a longer select and `&company_id=eq.1`.
    expect(t.reference).toBeGreaterThan(t.lines);
  });
});

describe('assessCompany', () => {
  it('a company with no amendment is EMPTY and nothing else — never "within limits"', () => {
    const a = assessCompany(row({ amendments_total: '0', page_rows: '0' }), { lines: null, poLines: null, pos: null, reference: null });
    expect(kinds(a)).toEqual(['EMPTY']);
  });

  it('small lists and small reads are WITHIN_LIMITS', () => {
    expect(kinds(assessCompany(row(), small))).toEqual(['WITHIN_LIMITS']);
  });

  it('the byte edges: over the budget at budget+1, refused-size at the refused datum', () => {
    expect(kinds(assessCompany(row(), { ...small, poLines: URL_BUDGET_BYTES }))).toEqual(['WITHIN_LIMITS']);
    expect(kinds(assessCompany(row(), { ...small, poLines: URL_BUDGET_BYTES + 1 }))).toEqual(['URI_OVER_BUDGET']);
    expect(kinds(assessCompany(row(), { ...small, poLines: REFUSED_URI_BYTES - 1 }))).toEqual(['URI_OVER_BUDGET']);
    expect(kinds(assessCompany(row(), { ...small, poLines: REFUSED_URI_BYTES }))).toEqual(['URI_AT_REFUSED_SIZE']);
  });

  it('the row edge: the ceiling itself is still complete, one past it truncates', () => {
    expect(kinds(assessCompany(row({ line_rows: String(ASSUMED_ROW_CEILING) }), small))).toEqual(['WITHIN_LIMITS']);
    expect(kinds(assessCompany(row({ line_rows: String(ASSUMED_ROW_CEILING + 1) }), small))).toEqual(['ROW_CEILING_EXCEEDED']);
    expect(kinds(assessCompany(row({ po_line_rows: String(ASSUMED_ROW_CEILING + 1) }), small))).toEqual(['ROW_CEILING_EXCEEDED']);
  });

  it('any line or PO of the other company is CROSS_COMPANY', () => {
    expect(kinds(assessCompany(row({ pos_other_company: '1', page_rows_with_foreign_po: '2' }), small))).toEqual(['CROSS_COMPANY']);
    expect(kinds(assessCompany(row({ lines_other_company: '1' }), small))).toEqual(['CROSS_COMPANY']);
  });

  it('projects a full page only while the page is not full, and says it is a projection', () => {
    const notFull = assessCompany(row(), small);
    expect(notFull.facts.projectedFullPage).toEqual({
      lineRows: Math.round(90 * (LIST_WINDOW / 40)),
      poLinesBytes: Math.round(900 * (LIST_WINDOW / 40)),
      daysToFull: Math.ceil((LIST_WINDOW - 40) / (10 / 30)),
    });
    expect(describeCompany(notFull).join('\n')).toMatch(/PROJECTION \(not a measurement\)/);

    const full = assessCompany(row({ amendments_total: '812', page_rows: String(LIST_WINDOW) }), small);
    expect(full.facts.pageFull).toBe(true);
    expect(full.facts.projectedFullPage).toBeNull();
    expect(describeCompany(full).join('\n')).not.toMatch(/PROJECTION/);
  });
});

describe('what a run prints is counts and sizes only — the Actions log is public', () => {
  it('no SO number or id handed to the assessment reaches the printed lines', async () => {
    const secretDoc = 'HC-SO-987654';
    const secretItem = uuid(0xabcdef);
    const secretPo = uuid(0xfedcba);
    const r = row({ doc_nos: [secretDoc], item_ids: [secretItem], po_ids: [secretPo] });
    const printed = describeCompany(assessCompany(r, await measureRequestTargets(r))).join('\n');
    expect(printed).not.toContain(secretDoc);
    expect(printed).not.toContain(secretItem);
    expect(printed).not.toContain(secretPo);
    expect(printed).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('assessScope', () => {
  const clean = {
    order_doc_no_unique_index: true,
    order_doc_nos_duplicated: '0',
    line_doc_nos_in_two_companies: '0',
    lines_company_not_order_company: '0',
    po_lines_bound_across_companies: '0',
    amendments_company_not_order_company: '0',
    amendments_without_company: '0',
  };

  it('clean tables are NO_COLLISION', () => {
    expect(kinds(assessScope(clean))).toEqual(['NO_COLLISION']);
  });

  it('each drift is named, and a missing index is its own finding', () => {
    expect(kinds(assessScope({ ...clean, order_doc_no_unique_index: false }))).toEqual(['DOC_NO_NOT_UNIQUE_BY_INDEX']);
    expect(kinds(assessScope({ ...clean, line_doc_nos_in_two_companies: '3' }))).toEqual(['DOC_NO_COLLISION']);
    expect(kinds(assessScope({ ...clean, po_lines_bound_across_companies: '1' }))).toEqual(['COMPANY_DRIFT']);
  });

  it('company-less amendments are printed, not folded into a verdict', () => {
    const a = assessScope({ ...clean, amendments_without_company: '4' });
    expect(kinds(a)).toEqual(['NO_COLLISION']);
    expect(describeScope(a).join('\n')).toMatch(/amendments with no company \(never listed\) : 4/);
  });
});
