import { describe, expect, test } from 'vitest';
import { fakeSb } from './fake-postgrest';
import { loadGrnAuditMeta } from './grn-audit-meta';

type Sb = Parameters<typeof loadGrnAuditMeta>[0];
const asSb = (v: unknown) => v as Sb;

const grnRows = () => [
  { id: 'grn-uuid-1', grn_number: 'GRN-2608-014', company_id: 2, status: 'RECEIVED' },
  { id: 'grn-uuid-2', grn_number: 'GRN-2608-015', company_id: 1, status: 'DRAFT' },
];

describe('loadGrnAuditMeta', () => {
  test('reads the header fields off the GRN row it was asked about', async () => {
    const sb = asSb(fakeSb({ grns: grnRows() }));
    await expect(loadGrnAuditMeta(sb, 'grn-uuid-1')).resolves.toEqual({
      docNo: 'GRN-2608-014',
      companyId: 2,
      status: 'RECEIVED',
    });
  });

  test('a GRN that is not there reads as nulls, not a throw', async () => {
    await expect(loadGrnAuditMeta(asSb(fakeSb({ grns: grnRows() })), 'gone')).resolves.toEqual({
      docNo: null,
      companyId: null,
      status: null,
    });
  });

  test('a 42703 read failure degrades to nulls so the write it describes survives', async () => {
    const sb = asSb(fakeSb({ grns: grnRows() }, { grns: ['grn_number'] }));
    await expect(loadGrnAuditMeta(sb, 'grn-uuid-1')).resolves.toEqual({
      docNo: null,
      companyId: null,
      status: null,
    });
  });

  test('a client that throws outright is swallowed into nulls too', async () => {
    const sb = asSb({
      from() { throw new Error('supabase down'); },
    });
    await expect(loadGrnAuditMeta(sb, 'grn-uuid-1')).resolves.toEqual({
      docNo: null,
      companyId: null,
      status: null,
    });
  });
});
