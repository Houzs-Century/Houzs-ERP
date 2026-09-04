/* THE BUG THIS PINS. `customerStatusFor` — the ONLY customer-facing answer to
   "what is this case's status?" — was a hand-written switch that enumerated
   nine stages plus six legacy aliases and ended `default: { label: stage }`.
   `voided` is a real stored stage (ALL_STAGES, services/assr.ts), so the portal
   printed the raw database slug `voided` at a customer.

   And not only on voided cases. portal.ts builds the salesperson stepper by
   mapping ALL_STAGES through customerStatusFor, so the slug appeared as a STEP
   LABEL on every sales-portal view of every case. Four other files each had
   their own copy of the wording; three of them knew about `voided` and gave two
   different answers for it.

   ── WHERE THE CALL-SITE PINNING LIVES ───────────────────────────────────────
   Asserting the shared function is right is the easy half and it is not the
   half that broke. Every one of these copies was written by someone who could
   not reach the layer that already had the answer; the way this comes back is
   one call site quietly growing its own table again, which no behaviour test of
   the shared module can see. That half is a SOURCE-slice test, and it lives in
   frontend/src/vendor/scm/lib/assr-stage-labels.canonical.test.ts — including
   the assertions about the three BACKEND call sites. Not a filing accident: the
   backend tsconfig sets `types: ["@cloudflare/workers-types"]` and has no
   node:fs, so a backend test cannot read a file. The frontend suite already
   reaches across the tree for exactly this reason (phone.canonical.test.ts
   reads ../backend/src/scm/shared/phone.ts), and that is the idiom followed. */

import { describe, expect, test } from 'vitest';
import {
  ASSR_CUSTOMER_STAGE_LABEL,
  ASSR_SHEET_STATUS,
  ASSR_STAGE_LABEL,
  assrCustomerStatus,
  assrStageLabel,
} from './assr-stage-labels';
import { ALL_STAGES } from '../../services/assr';
import { customerStatusFor } from '../../services/caseTracking';

describe('voided — the stage the customer-facing copy never learned', () => {
  test('the portal names it instead of printing the database slug', () => {
    expect(assrCustomerStatus('voided')).toEqual({
      label: 'Voided — Not Valid',
      color: 'grey',
    });
  });

  test('customerStatusFor, the function portal.ts actually calls, agrees', () => {
    expect(customerStatusFor('voided').label).toBe('Voided — Not Valid');
  });

  test('the printed report and the portal now say the SAME words for it', () => {
    // They did not: the report said "Voided — Not Valid", the portal said
    // "voided", and the sheet export said "Voided". Two of those three are
    // this test; the third is deliberate and pinned separately below.
    expect(assrStageLabel('voided')).toBe(customerStatusFor('voided').label);
  });

  test('NO stage the column can hold renders as its own slug', () => {
    /* The property, not the instance. `voided` was the hole; the next stage
       added to ALL_STAGES would open a new one in exactly the same way, and
       nothing would error. */
    for (const stage of ALL_STAGES) {
      const { label } = customerStatusFor(stage);
      expect(label, `${stage} has no customer wording`).not.toBe(stage);
      expect(label, `${stage} renders as a slug`).not.toMatch(/_/);
    }
  });

  test('the sales stepper portal.ts builds carries no slug either', () => {
    /* portal.ts:131 — `ALL_STAGES.map((s) => ({ label: customerStatusFor(s).label }))`.
       This is that expression. It is the reason the blast radius was every
       sales-portal view and not only the voided ones. */
    const stepper = ALL_STAGES.map((s) => customerStatusFor(s).label);
    expect(stepper).not.toContain('voided');
    expect(stepper).toContain('Voided — Not Valid');
  });
});

describe('the labels every OTHER stage had, byte for byte as before', () => {
  /* The whole switch that used to live in caseTracking.ts, transcribed from the
     pre-change source. Unification is only honest if the fifteen answers that
     were already agreed come back identical — the one line that changes is
     `voided`, and this is what proves it is the only one. */
  const before: Array<[string, string, string]> = [
    ['pending_review', 'Pending Review', 'grey'],
    ['under_verification', 'Under Verification', 'blue'],
    ['pending_solution', 'Pending Solution', 'amber'],
    ['pending_inspection', 'Under Verification', 'blue'],
    ['pending_item_pickup', 'Pending Supplier Pickup', 'violet'],
    ['pending_supplier_pickup', 'Pending Supplier Pickup', 'violet'],
    ['pending_item_ready', 'Pending Item Ready', 'violet'],
    ['pending_delivery_service', 'Pending Delivery / Service', 'violet'],
    ['completed', 'Completed', 'green'],
    ['registration', 'Pending Review', 'grey'],
    ['triage', 'Under Verification', 'blue'],
    ['action', 'Pending Solution', 'amber'],
    ['logistics', 'Pending Item Pickup', 'violet'],
    ['resolution', 'Pending Delivery / Service', 'violet'],
    ['closed', 'Completed', 'green'],
  ];

  for (const [stage, label, color] of before) {
    test(`${stage} → "${label}" / ${color}`, () => {
      expect(customerStatusFor(stage)).toEqual({ label, color });
    });
  }

  test('an unknown value and a null still fall back exactly as they did', () => {
    expect(customerStatusFor('who_knows')).toEqual({ label: 'who_knows', color: 'grey' });
    expect(customerStatusFor(null)).toEqual({ label: 'Unknown', color: 'grey' });
    expect(customerStatusFor(undefined)).toEqual({ label: 'Unknown', color: 'grey' });
    expect(customerStatusFor('')).toEqual({ label: 'Unknown', color: 'grey' });
  });
});

describe('the app + document wording, unchanged from assr_print.ts', () => {
  const before: Array<[string, string]> = [
    ['pending_review', 'Pending Review'],
    ['under_verification', 'Under Verification'],
    ['pending_solution', 'Pending Solution'],
    // Renamed 2026-09-04 (Nico): the stage spans customer + supplier legs now,
    // so the name went neutral — the sub-status names the actor.
    ['pending_supplier_pickup', 'Pickup / Return'],
    ['pending_item_ready', 'Pending Item Ready'],
    ['pending_delivery_service', 'Pending Delivery / Service'],
    ['completed', 'Completed'],
    ['voided', 'Voided — Not Valid'],
    ['registration', 'Pending Review'],
    ['triage', 'Under Verification'],
    ['action', 'Pending Solution'],
    ['logistics', 'Pending Item Pickup'],
    ['resolution', 'Pending Delivery / Service'],
    ['closed', 'Completed'],
  ];

  for (const [stage, label] of before) {
    test(`${stage} → "${label}"`, () => {
      expect(assrStageLabel(stage)).toBe(label);
    });
  }

  test('an unrecognised value comes back untouched, as `X || cs.stage` did', () => {
    expect(assrStageLabel('who_knows')).toBe('who_knows');
    expect(assrStageLabel('')).toBe('');
    expect(assrStageLabel(null)).toBe('');
  });
});

describe('the ONE wording the portal deliberately keeps to itself', () => {
  /* Not swept up. The app and the printed report say "Supplier Pickup / Return"
     because ops switch between the two legs via the sub-status; the portal says
     "Pending Supplier Pickup" because the customer is only told the case is
     with the supplier. Both look intentional, so this is a question for the
     owner and not a bug to fix inside a refactor. Pinned so that neither side
     moves by accident while the question is open. */
  test('supplier pickup: portal and document say different things, on purpose', () => {
    expect(assrCustomerStatus('pending_supplier_pickup').label).toBe('Pending Supplier Pickup');
    expect(assrStageLabel('pending_supplier_pickup')).toBe('Pickup / Return');
  });

  test('and it is the ONLY one — every other stage agrees', () => {
    const disagreeing = Object.keys(ASSR_STAGE_LABEL).filter(
      (k) => assrCustomerStatus(k).label !== assrStageLabel(k),
    );
    expect(disagreeing.sort()).toEqual(['pending_item_pickup', 'pending_supplier_pickup']);
    expect(Object.keys(ASSR_CUSTOMER_STAGE_LABEL).sort()).toEqual(disagreeing.sort());
  });
});

describe('the Google Sheet vocabulary is NOT the app vocabulary', () => {
  /* assrFormIntake.ts rewrites a column of the ops delivery sheet from this,
     and the sheet's stats block COUNTS these exact strings. Folding it into the
     app's words would break the spreadsheet's counters silently — a different
     failure from a customer reading a slug, which is why it stayed a separate
     export. Byte-identical to what shipped before this change. */
  test('every string is exactly what the sheet counts today', () => {
    expect(ASSR_SHEET_STATUS).toEqual({
      pending_review: 'Pending Review',
      under_verification: 'Under Verification',
      pending_solution: 'Pending Solution',
      pending_supplier_pickup: 'Pending Supplier Pickup',
      pending_item_ready: 'Pending Item Ready',
      pending_delivery_service: 'Pending Delivery/Service',
      completed: 'Completed',
      voided: 'Voided',
    });
  });

  test('the two strings that must NOT become the app words stay different', () => {
    // No spaces around the slash, and a bare "Voided". Both deliberate.
    expect(ASSR_SHEET_STATUS.pending_delivery_service).not.toBe(
      assrStageLabel('pending_delivery_service'),
    );
    expect(ASSR_SHEET_STATUS.voided).not.toBe(assrStageLabel('voided'));
  });
});
