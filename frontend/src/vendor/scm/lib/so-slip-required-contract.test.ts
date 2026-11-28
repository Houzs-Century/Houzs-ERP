
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SLIP_REQUIRED_REASON, slipMissingProblem } from './payment-slip-gate';
import { CONVERT_LABEL } from './so-money-queries';

const read = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), 'utf8');

const desktopSource = read('src/pages/scm-v2/SalesOrderNew.tsx');
const mobileSource = read('src/mobile/MobileNewSO.tsx') + read('src/mobile/MobileSoPayCard.tsx');
const sheetSource = read('src/mobile/RecordedPayments.tsx');
const tableSource = read('src/vendor/scm/components/PaymentsTable.tsx');

const sliceFrom = (source: string, startAnchor: string, endAnchor: string): string => {
  const start = source.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('slipMissingProblem (lib/payment-slip-gate) — the rule plus the three things the rule must not know', () => {
  test('a keyed row with no slip is refused in the shared sentence', () => {
    expect(slipMissingProblem({ methodLabel: 'Cash', slipUploadSessionId: null })).toBe(SLIP_REQUIRED_REASON);
    expect(slipMissingProblem({ methodLabel: 'Merchant', slipUploadSessionId: '' })).toBe(SLIP_REQUIRED_REASON);
  });

  test('an uploaded slip or a scanned receipt is the proof', () => {
    expect(slipMissingProblem({ methodLabel: 'Cash', slipUploadSessionId: 'sess-1' })).toBeNull();
    expect(slipMissingProblem({ methodLabel: 'Merchant', slipUploadSessionId: null, receiptImageKey: 'scan-slips/r.jpg' })).toBeNull();
  });

  test('money moved from another order needs none', () => {
    expect(slipMissingProblem({ methodLabel: CONVERT_LABEL, slipUploadSessionId: null })).toBeNull();
  });

  test('an edit of a booked payment keeps the slip it has', () => {
    expect(slipMissingProblem({ methodLabel: 'Cash', slipUploadSessionId: null, editingPersistedId: 'pay-1' })).toBeNull();
  });
});

describe('every keying surface gates on the one rule', () => {
  test('desktop panel: the per-row Save, the batch commit and the button all ask it', () => {
    expect(sliceFrom(tableSource, 'const commitDraftOnce = ', 'const commitAllDrafts = ')).toContain('slipMissingProblem(d)');
    expect(sliceFrom(tableSource, 'const commitAllDrafts = ', 'const paidSen = isSaved')).toContain('slipMissingProblem(d)');
    const button = sliceFrom(tableSource, 'const noAmount = d.amountSen <= 0;', 'onClick={() => commitDraft(d)}');
    expect(button).toContain('const noSlip   = slipMissingProblem(d);');
    expect(button).toContain('noSlip !== null');
    expect(button).toContain('!noSlip && needsRequest(d)');
  });

  test('phone sheet: canSave waits on the slip, except when editing', () => {
    expect(sheetSource).toContain('const slipMissing = isEdit ? null : slipMissingProblem({ methodLabel: method, slipUploadSessionId: slipSession || null });');
    expect(sheetSource).toContain('!slipMissing &&');
    expect(sheetSource).toContain('"Slip (required)"');
  });

  test('desktop New SO: a slip-less row blocks the save, live and on the press', () => {
    expect(desktopSource).toContain('slipMissingProblem(d) !== null');
    expect(desktopSource).toContain('[...backendLiveProblems, ...scannedExtras, ...slipMissingExtras, ...slipDateExtras]');
    expect(desktopSource).toContain('[...serverProblems, ...scannedExtras, ...slipMissingExtras, ...slipDateExtras]');
  });

  test('phone New SO: a slip-less row blocks the save through the same list the press reads', () => {
    expect(mobileSource).toContain('slipMissingProblem({ methodLabel: p.method, slipUploadSessionId: p.slipSession || null }) !== null');
    expect(mobileSource).toContain('[emailErr, unpickedLines, outOfWindowPayments, slipMissingPayments]');
    expect(mobileSource).toContain('const problems = [...serverProblems, ...soClientExtras];');
    expect(mobileSource).toContain('"Slip (required)"');
  });

  test('the uploaders say so', () => {
    const uploaders = tableSource.match(/<SlipUploadField[\s\S]{0,160}?required=[^\n]*/g) ?? [];
    expect(uploaders.length).toBe(3);
    expect(uploaders.filter((u) => u.includes('required={false}')).length).toBe(1);
    expect(uploaders.some((u) => u.includes('required={!d.editingPersistedId}'))).toBe(true);
    expect(uploaders.some((u) => u.includes('required={d.methodLabel !== CONVERT_LABEL}'))).toBe(true);
  });
});

describe('the writers are still blind to the slip — the gate is before the save, never in the filter', () => {
  test('mobile: the rows to post are chosen on amount, and only amount', () => {
    const recorder = sliceFrom(mobileSource, 'async function recordNewPayments(', 'if (failed > 0) {');
    expect(recorder).toContain('const rows = pays.filter((p) => toSen(p.amount) > 0);');
    expect(recorder).not.toMatch(/p\.slipSession\s*&&/);
    expect(recorder).toContain('uploadSessionId: p.slipSession || null,');
  });

  test('mobile: the create-time deposit gate counts every row the recorder will post', () => {
    const body = sliceFrom(mobileSource, 'pendingDepositSen: (() => {', 'items,');
    expect(body).toContain('.filter((p) => toSen(p.amount) > 0 && !isBackdateRow(p))');
    expect(body).not.toContain('p.slipSession');
  });

  test('desktop: the rows to post are chosen on amount (receipt-backed rows go their own way)', () => {
    expect(desktopSource).toContain(
      'const paymentIntents = () => paymentDrafts.filter((d) => d.amountSen > 0 && !d.receiptImageKey && !backdateRows().includes(d));',
    );
    const flush = sliceFrom(desktopSource, 'const flushPaymentDrafts =', 'const results:');
    expect(flush).toContain('uploadSessionId: d.slipUploadSessionId,');
    expect(flush).not.toMatch(/\.filter\([^)]*slipUploadSessionId/);
  });

  test('desktop: the create-time deposit gate counts exactly the rows the flush will post', () => {
    expect(desktopSource).toContain('const pendingDepositSen = paymentIntents()');
    const gate = sliceFrom(desktopSource, 'const pendingDepositSen = paymentIntents()', 'settleMutation(create.mutate,');
    expect(gate).not.toContain('slipUploadSessionId');
  });
});

describe('the OCR / Scan-Order receipt is still the proof, once', () => {
  test('a scanned receipt is recorded through the create body and tagged on the draft', () => {
    expect(desktopSource).toContain('(d) => d.amountSen > 0 && Boolean(d.receiptImageKey),');
    expect(desktopSource).toContain('receiptImageKey: scanReceiptImageKey || undefined,');
    const seed = sliceFrom(desktopSource, 'if (payload.payment?.methodValue) {', 'const lineMeta:');
    expect(seed).toContain('receiptImageKey:        payload.receiptImageKey');
    expect(tableSource).toContain('receiptImageKey?:         string;');
  });
});
