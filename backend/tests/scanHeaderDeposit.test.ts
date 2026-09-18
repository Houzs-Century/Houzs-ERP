// Unit tests for the scan draft's SAFE HEADER DEPOSIT (lib/scan-header-deposit).
// Route-level coverage of runScanJob isn't possible in this harness (it rides
// Supabase Postgres + R2 + the Anthropic call), so these pin the PURE decision
// the background job relies on: a scan may stamp `deposit_sen` on the header ONLY
// when a receipt will book the backing is_deposit ledger row — otherwise soPaidSen
// ((is_deposit ? 0 : deposit_sen) + Σ rows) double-counts the deposit once the
// operator records the payment (docs/bugs/0785-*).
import { describe, expect, test } from 'vitest';
import { safeScanDepositSen } from '../src/scm/lib/scan-header-deposit';

describe('safeScanDepositSen', () => {
  test('receiptless scan drops the header deposit (the reported bug)', () => {
    // Slip said "dep 1400" but no merchant copy was scanned, so nothing books an
    // is_deposit row. Stamping 140000 sen here is what doubled to 280000 once the
    // operator added the real payment. Must be 0.
    expect(safeScanDepositSen(140000, { isShell: false, hasClassifiedReceipt: false })).toBe(0);
  });

  test('receipt-backed scan keeps the deposit unchanged', () => {
    // recordScanReceiptPayments will book the is_deposit row, so the header figure
    // is legitimate (and soPaidSen ignores it anyway, but reports/PDF read it).
    expect(safeScanDepositSen(140000, { isShell: false, hasClassifiedReceipt: true })).toBe(140000);
  });

  test('a SHELL draft drops the deposit even with a classified receipt', () => {
    // The shell path returns before the receipt-payment pass, so no is_deposit row
    // is ever booked — a stamped deposit would orphan.
    expect(safeScanDepositSen(50000, { isShell: true, hasClassifiedReceipt: true })).toBe(0);
    expect(safeScanDepositSen(50000, { isShell: true, hasClassifiedReceipt: false })).toBe(0);
  });

  test('zero / negative / non-finite deposits collapse to 0', () => {
    // A negative would deflate the paid rollup; guard it regardless of receipt.
    expect(safeScanDepositSen(0, { isShell: false, hasClassifiedReceipt: true })).toBe(0);
    expect(safeScanDepositSen(-100, { isShell: false, hasClassifiedReceipt: true })).toBe(0);
    expect(safeScanDepositSen(Number.NaN, { isShell: false, hasClassifiedReceipt: true })).toBe(0);
    expect(safeScanDepositSen(Number.POSITIVE_INFINITY, { isShell: false, hasClassifiedReceipt: true })).toBe(0);
  });

  test('a receipt-backed deposit is rounded to whole sen', () => {
    expect(safeScanDepositSen(1499.6, { isShell: false, hasClassifiedReceipt: true })).toBe(1500);
  });
});
