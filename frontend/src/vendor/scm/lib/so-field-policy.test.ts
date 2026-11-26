import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SO_HEADER_FIELD_POLICY,
  soAmendableHeaderKeys,
  soProcessingLockColumns,
  soHeaderFieldClass,
  paymentRowMutable,
  PAYMENT_WINDOW_CLOSED_MESSAGE,
} from './so-field-policy';
import { AMENDABLE_HEADER_KEYS } from './so-amendment-header';

const BACKEND_POLICY_PATH = resolve(
  __dirname,
  '../../../../../backend/src/scm/shared/so-field-policy.ts',
);

function backendPolicyRows(): Array<{ column: string; payloadKey: string; label: string; cls: string }> {
  const src = readFileSync(BACKEND_POLICY_PATH, 'utf8');
  const start = src.indexOf('export const SO_HEADER_FIELD_POLICY');
  expect(start, 'backend SO_HEADER_FIELD_POLICY not found — did the file move?').toBeGreaterThan(-1);
  const block = src.slice(start);
  const rows: Array<{ column: string; payloadKey: string; label: string; cls: string }> = [];
  const rowRe =
    /column:\s*'([^']+)',\s*\n?\s*payloadKey:\s*'([^']+)',\s*\n?\s*label:\s*'([^']+)',\s*\n?\s*cls:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block)) !== null) {
    rows.push({ column: m[1], payloadKey: m[2], label: m[3], cls: m[4] });
  }
  return rows;
}

describe('so-field-policy — frontend mirror matches the backend source of truth', () => {
  it('parses a non-trivial policy table out of the backend file', () => {
    expect(backendPolicyRows().length).toBeGreaterThanOrEqual(6);
  });

  it('has the same rows, in the same order, with the same classes', () => {
    const backend = backendPolicyRows();
    const frontend = SO_HEADER_FIELD_POLICY.map((f) => ({
      column: f.column, payloadKey: f.payloadKey, label: f.label, cls: f.cls,
    }));
    expect(frontend).toEqual(backend);
  });

  it('keeps the lock set and the amendment allow-list in step', () => {
    const locked = soProcessingLockColumns();
    const amendableCols = new Set(
      SO_HEADER_FIELD_POLICY.filter((f) => f.cls === 'CONTROLLED').map((f) => f.column),
    );
    const derivedCols = new Set(
      SO_HEADER_FIELD_POLICY.filter((f) => f.cls === 'DERIVED').map((f) => f.column),
    );
    for (const col of locked) {
      const requestable = amendableCols.has(col) || derivedCols.has(col);
      expect(requestable, `${col} is frozen but has no amendment path`).toBe(true);
    }
    for (const col of amendableCols) {
      expect(locked.has(col), `${col} is amendable but not frozen`).toBe(true);
    }
  });

  it('classifies the owner-ruled free-edit fields as FREE', () => {
    // What remains free after the 2026-08-21 customer-info reversal: note,
    // emergency contacts, customer type. The delivery ADDRESS left this list
    // 2026-07-27 (two-lane phase 2); customer name / phone / email left it
    // 2026-08-21 ("需要加上更新客户信息") — see the CONTROLLED test below.
    for (const key of ['note', 'emergencyContactName', 'customerType']) {
      expect(soHeaderFieldClass(key)).toBe('FREE');
    }
  });

  it('classifies the delivery/charge-affecting fields as CONTROLLED', () => {
    for (const key of [
      'customerDeliveryDate', 'processingDate', 'customerState', 'postcode', 'city',
      // Two-lane phase 2 (owner 2026-07-27): the address block + disposal note.
      'address1', 'address2', 'address3', 'address4',
      'shipToAddress', 'billToAddress', 'installToAddress', 'replacementDisposal',
      // Customer info (owner 2026-08-21): the contact block rides the
      // DELIVERY-lane amendment once the SO is locked.
      'debtorName', 'phone', 'email',
    ]) {
      expect(soHeaderFieldClass(key)).toBe('CONTROLLED');
    }
  });

  it('excludes the DERIVED salesLocation from the amendment allow-list', () => {
    expect(soProcessingLockColumns().has('sales_location')).toBe(true);
    expect(soAmendableHeaderKeys()).not.toContain('salesLocation');
    expect(soHeaderFieldClass('salesLocation')).toBe('DERIVED');
  });
});

describe('so-amendment-header — AMENDABLE_HEADER_KEYS tracks the policy table', () => {
  it('is exactly the CONTROLLED payload keys, in table order', () => {
    expect([...AMENDABLE_HEADER_KEYS]).toEqual(soAmendableHeaderKeys());
  });
});

describe('so-field-policy — payment same-day window (Owner 2026-07-19)', () => {
  const TODAY = '2026-07-19';

  it('lets a payment keyed in TODAY be changed — same day is fluid', () => {
    expect(paymentRowMutable(TODAY, TODAY, false)).toEqual({ mutable: true, problem: null, via: 'same_day' });
  });

  it('LOCKS a payment keyed in on any earlier day', () => {
    const r = paymentRowMutable('2026-07-18', TODAY, false);
    expect(r.mutable).toBe(false);
    expect(r.problem).toBe(PAYMENT_WINDOW_CLOSED_MESSAGE);
  });

  it('locks a payment from yesterday even by one calendar day', () => {
    expect(paymentRowMutable('2026-07-18', '2026-07-19', false).mutable).toBe(false);
  });

  it('exempts DRAFT sales orders — a draft has nothing locked yet', () => {
    expect(paymentRowMutable('2020-01-01', TODAY, true).mutable).toBe(true);
  });

  it('explains WHY in plain language, with no error code or jargon leaking', () => {
    const msg = paymentRowMutable('2026-07-18', TODAY, false).problem;
    expect(msg).not.toBeNull();
    expect(msg as string).not.toMatch(/[{}]|\bnull\b|\bundefined\b|payment_edit_locked/);
    expect((msg as string).length).toBeLessThan(200);
    expect(msg as string).toMatch(/day it was keyed in/i);
  });

  /* The three RECONCILED sentences travel the same filter, with a date, an
     entry number or an account code inside them. At 209–219 characters they
     were dropped and the operator saw the generic 409 (docs/bugs/0821). */
  it('every reconciled refusal stays under the sentence filter\'s 200 characters', () => {
    const kinds = [
      { kind: 'merchant' as const, on: '2026-09-11' },
      { kind: 'bank' as const, jeNo: '2990-JE-2607-0052' },
      { kind: 'month' as const, month: '2026-06', accountCode: '310-0020' },
    ];
    for (const reconciled of kinds) {
      const msg = paymentRowMutable('2026-07-18', TODAY, false, { mayAmend: true, reconciled }).problem;
      expect(msg).not.toBeNull();
      expect((msg as string).length).toBeLessThan(200);
      expect(msg as string).not.toMatch(/[{}]|\bnull\b|\bundefined\b|payment_edit_locked|\b\d{5}\b/);
      expect(msg as string).toMatch(/undo|reopen/i);
    }
  });
});

describe('so-field-policy — who may correct a payment (Owner + management 2026-09-10)', () => {
  const TODAY = '2026-09-10';
  const OLD = '2026-08-02';

  it('opens an older payment for a holder of the amend right', () => {
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: true }))
      .toEqual({ mutable: true, problem: null, via: 'amend' });
  });

  it('leaves it shut for everybody else, exactly as before', () => {
    expect(paymentRowMutable(OLD, TODAY, false, { mayAmend: false }).mutable).toBe(false);
    expect(paymentRowMutable(OLD, TODAY, false).mutable).toBe(false);
  });

  it('shuts a RECONCILED payment to the holder of the right as well', () => {
    const r = paymentRowMutable(OLD, TODAY, false, {
      mayAmend: true, reconciled: { kind: 'bank', jeNo: 'JE-2608-0031' },
    });
    expect(r.mutable).toBe(false);
    expect(r.problem).toMatch(/JE-2608-0031/);
  });

  it('shuts a reconciled payment even on the day it was keyed', () => {
    expect(paymentRowMutable(TODAY, TODAY, false, {
      reconciled: { kind: 'merchant', on: '2026-09-10' },
    }).mutable).toBe(false);
  });
});
