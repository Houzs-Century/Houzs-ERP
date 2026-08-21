// ----------------------------------------------------------------------------
// so-field-policy drift test.
//
// The SO edit policy (FREE vs CONTROLLED) has to exist in two places because
// backend and frontend are separate TypeScript builds with no shared import
// path. Before this test, three hand-mirrored literals were kept in step by
// PROSE COMMENTS ALONE — and they had already drifted: `city` was disabled by
// the mobile UI and named in its lock copy while appearing in NEITHER backend
// set, so a posted City change wrote straight through on a locked SO and no
// amendment could carry it.
//
// This test reads the BACKEND table off disk and asserts the frontend mirror
// still matches it row-for-row. It runs in the frontend CI job. If you edit one
// table and not the other, this fails.
// ----------------------------------------------------------------------------
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

/* frontend/src/vendor/scm/lib -> repo root -> backend source of truth. */
const BACKEND_POLICY_PATH = resolve(
  __dirname,
  '../../../../../backend/src/scm/shared/so-field-policy.ts',
);

/** Pull the policy rows out of the backend file by parsing its literal. We
    parse rather than import because the backend is a different tsconfig
    project (workers types, its own module resolution) — importing it into the
    frontend build would drag that in. Parsing keeps the test hermetic. */
function backendPolicyRows(): Array<{ column: string; payloadKey: string; label: string; cls: string }> {
  const src = readFileSync(BACKEND_POLICY_PATH, 'utf8');
  const start = src.indexOf('export const SO_HEADER_FIELD_POLICY');
  expect(start, 'backend SO_HEADER_FIELD_POLICY not found — did the file move?').toBeGreaterThan(-1);
  const block = src.slice(start);
  const rows: Array<{ column: string; payloadKey: string; label: string; cls: string }> = [];
  /* Each row is a `{ column: '..', payloadKey: '..', label: '..', cls: '..', reason: .. }`
     object literal. `reason` is prose and deliberately NOT compared. */
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
    // Guards the regex itself: a silently-empty parse would make every
    // comparison below vacuously pass.
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
    /* THE INVARIANT that used to be prose in three files: every column the
       server freezes must be requestable through the amendment, EXCEPT the
       DERIVED ones which the server recomputes. A column frozen with no
       amendment path is a field nobody can ever change again. */
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
    // And nothing amendable is un-frozen (that would be an approval queue for a
    // field Save could already write directly).
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
    // It is frozen, but the server recomputes it from State — a client that
    // SENDS it trips the lock diff, so it must never be offered as amendable.
    expect(soProcessingLockColumns().has('sales_location')).toBe(true);
    expect(soAmendableHeaderKeys()).not.toContain('salesLocation');
    expect(soHeaderFieldClass('salesLocation')).toBe('DERIVED');
  });
});

describe('so-amendment-header — AMENDABLE_HEADER_KEYS tracks the policy table', () => {
  it('is exactly the CONTROLLED payload keys, in table order', () => {
    /* AMENDABLE_HEADER_KEYS has to stay an `as const` literal because
       AmendableHeaderKey is a union type the whole amendment surface depends
       on, and a function returning string[] cannot produce it. This assertion
       is what stops that literal from becoming a fourth list that drifts. */
    expect([...AMENDABLE_HEADER_KEYS]).toEqual(soAmendableHeaderKeys());
  });
});

describe('so-field-policy — payment same-day window (Owner 2026-07-19)', () => {
  const TODAY = '2026-07-19';

  it('lets a payment keyed in TODAY be changed — same day is fluid', () => {
    expect(paymentRowMutable(TODAY, TODAY, false)).toEqual({ mutable: true, problem: null });
  });

  it('LOCKS a payment keyed in on any earlier day', () => {
    const r = paymentRowMutable('2026-07-18', TODAY, false);
    expect(r.mutable).toBe(false);
    expect(r.problem).toBe(PAYMENT_WINDOW_CLOSED_MESSAGE);
  });

  it('locks a payment from yesterday even by one calendar day', () => {
    // The boundary is the thing worth testing: 23:59 yesterday MYT is locked.
    expect(paymentRowMutable('2026-07-18', '2026-07-19', false).mutable).toBe(false);
  });

  it('exempts DRAFT sales orders — a draft has nothing locked yet', () => {
    expect(paymentRowMutable('2020-01-01', TODAY, true).mutable).toBe(true);
  });

  it('explains WHY in plain language, with no error code or jargon leaking', () => {
    const msg = paymentRowMutable('2026-07-18', TODAY, false).problem;
    expect(msg).not.toBeNull();
    // Survives humanApiError's sentence filter: no braces, no bare status code.
    expect(msg as string).not.toMatch(/[{}]|\bnull\b|\bundefined\b|payment_edit_locked/);
    expect((msg as string).length).toBeLessThan(200);
    expect(msg as string).toMatch(/day it was keyed in/i);
  });
});
