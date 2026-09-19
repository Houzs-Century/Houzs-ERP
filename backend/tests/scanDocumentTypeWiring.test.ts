import { describe, expect, test } from 'vitest';
import scanSoSrc from '../src/scm/routes/scan-so.ts?raw';
import scanSoSerializeSrc from '../src/scm/routes/scan-so-serialize.ts?raw';

// OCR slice 1 (tasks/PLAN-ocr-scan-gr-pi.md) adds a document_type dimension to
// the SO scan pipeline WITHOUT changing SO behaviour. scm.scan_jobs has no D1
// twin, so there is no integration harness that inserts a real row in the test
// DB (migration 0067 note); this pins the WIRING the way soConfirmGateWiring
// pins the SO guards — a refactor cannot silently unhook the column from the
// enqueue insert, the done-touch link, the sample stamp, or the reads.

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

describe('scan_jobs enqueue insert carries document_type on the SO path', () => {
  test('the enqueue insert stamps the default document type', () => {
    const insert = between(scanSoSrc, "scanSo.post('/enqueue'", '.select(\'id\')');
    expect(insert).toContain(".from('scan_jobs')");
    expect(insert).toContain('document_type: DEFAULT_SCAN_DOCUMENT_TYPE');
  });

  test('the SO default is imported from the shared vocabulary module', () => {
    // The constant's value ('SO') is unit tested in scan-document-type.test.ts;
    // here we only prove the pipeline pulls it from that one seam rather than
    // re-declaring a literal that could drift from the column default.
    expect(scanSoSrc).toContain("from '../lib/scan-document-type'");
    expect(scanSoSrc).toContain('DEFAULT_SCAN_DOCUMENT_TYPE');
    expect(scanSoSrc).toContain('coerceScanDocumentType');
  });
});

describe('a completed SO scan writes linked_doc_no alongside so_doc_no', () => {
  test('every done-touch that sets so_doc_no also sets linked_doc_no', () => {
    // Count both so nothing that finishes a job can set one without the other.
    const soDoc = scanSoSrc.match(/so_doc_no: docNo/g) ?? [];
    const linked = scanSoSrc.match(/linked_doc_no: docNo/g) ?? [];
    expect(soDoc.length).toBeGreaterThanOrEqual(3);
    expect(linked.length).toBe(soDoc.length);
  });
});

describe('the learning sample is stamped with the document type', () => {
  test('insertScanSample writes document_type from its required param', () => {
    const fn = between(scanSoSrc, 'async function insertScanSample', 'return { sampleId');
    expect(fn).toContain('documentType: ScanDocumentType');
    expect(fn).toContain('document_type: args.documentType');
  });

  test('both SO callers pass a document type (extract + background job)', () => {
    // /extract passes the outer default; runScanJob threads the job's type.
    expect(scanSoSrc).toContain('documentType: DEFAULT_SCAN_DOCUMENT_TYPE');
    expect(scanSoSrc).toContain('documentType: job.documentType');
  });
});

describe('the queue consumer and reaper read + carry document_type', () => {
  test('processScanQueueMessage selects and coerces document_type', () => {
    const fn = between(scanSoSrc, 'export async function processScanQueueMessage', 'async function reapStaleScanJobs');
    expect(fn).toMatch(/select\('id, status, salesperson, salesperson_id, houzs_user_id, image_keys, company_id, document_type'\)/);
    expect(fn).toContain('coerceScanDocumentType(r.documentType ?? r.document_type)');
    expect(fn).toContain('documentType,');
  });

  test('the stale-job reaper selects and coerces document_type for its re-run', () => {
    const fn = between(scanSoSrc, 'async function reapStaleScanJobs', "scanSo.get('/jobs'");
    expect(fn).toContain('retry_count, company_id, document_type');
    expect(fn).toContain('coerceScanDocumentType(r.documentType ?? r.document_type)');
    expect(fn).toContain('documentType,');
  });
});

describe('the poll reads expose document_type and linked_doc_no', () => {
  test('both /jobs selects include the new columns', () => {
    const selects = scanSoSrc.match(
      /id, status, salesperson, so_doc_no, linked_doc_no, document_type, error, sample_id/g,
    ) ?? [];
    expect(selects.length).toBe(2);
  });

  test('jobToJson maps documentType and linkedDocNo', () => {
    const fn = between(scanSoSerializeSrc, 'function jobToJson', 'createdAt:');
    expect(fn).toContain('documentType: coerceScanDocumentType(r.documentType ?? r.document_type)');
    expect(fn).toContain('linkedDocNo:');
  });
});
