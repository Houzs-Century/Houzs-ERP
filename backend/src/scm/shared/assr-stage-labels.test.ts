
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
    expect(assrStageLabel('voided')).toBe(customerStatusFor('voided').label);
  });

  test('NO stage the column can hold renders as its own slug', () => {
    for (const stage of ALL_STAGES) {
      const { label } = customerStatusFor(stage);
      expect(label, `${stage} has no customer wording`).not.toBe(stage);
      expect(label, `${stage} renders as a slug`).not.toMatch(/_/);
    }
  });

  test('the sales stepper portal.ts builds carries no slug either', () => {
    const stepper = ALL_STAGES.map((s) => customerStatusFor(s).label);
    expect(stepper).not.toContain('voided');
    expect(stepper).toContain('Voided — Not Valid');
  });
});

describe('the labels every OTHER stage had, byte for byte as before', () => {
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
    expect(ASSR_SHEET_STATUS.pending_delivery_service).not.toBe(
      assrStageLabel('pending_delivery_service'),
    );
    expect(ASSR_SHEET_STATUS.voided).not.toBe(assrStageLabel('voided'));
  });
});
