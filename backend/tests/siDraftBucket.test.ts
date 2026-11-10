// Sister-ERP gap review G22: the Sales Invoices "Sent" tab counted drafts
// nobody had issued. DRAFT has its own bucket; Sent is SENT + OVERDUE. The
// route counts and the list filter both read SI_STATUS_BUCKETS, and so does
// the frontend tab via the bucket name.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SI_STATUS_BUCKETS } from '../src/scm/lib/si-status-buckets';

describe('sales invoice status buckets', () => {
  test('a draft is in the Draft tab, not in Sent', () => {
    expect(SI_STATUS_BUCKETS.draft).toEqual(['DRAFT']);
    expect(SI_STATUS_BUCKETS.sent).toEqual(['SENT', 'OVERDUE']);
  });

  test('the list route counts the draft bucket', () => {
    const src = readFileSync(new URL('../src/scm/routes/sales-invoices.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/countBase\(\)\.in\('status', SI_STATUS_BUCKETS\.draft\)/);
    expect(src).toMatch(/readStatusCounts\(\{ all: allC, draft: draftC,/);
  });
});
