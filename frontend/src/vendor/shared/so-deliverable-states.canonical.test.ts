import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SO_UNDELIVERABLE_STATUSES, soCanRaiseDo } from './so-deliverable-states';

describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/so-deliverable-states.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/so-deliverable-states.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/so-deliverable-states.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  test('the set is the four the server denies, and nothing else', () => {
    expect([...SO_UNDELIVERABLE_STATUSES]).toEqual(['DRAFT', 'CANCELLED', 'ON_HOLD', 'CLOSED']);
  });
});

describe('soCanRaiseDo', () => {
  test('READY_TO_SHIP can raise a Delivery Order', () => {
    expect(soCanRaiseDo('READY_TO_SHIP', false)).toBe(true);
  });

  test.each([
    'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED',
  ])('%s is deliverable', (status) => {
    expect(soCanRaiseDo(status, false)).toBe(true);
  });

  test.each(['DRAFT', 'CANCELLED', 'ON_HOLD', 'CLOSED'])('%s is NOT deliverable', (status) => {
    expect(soCanRaiseDo(status, false)).toBe(false);
  });

  test.each([
    'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED',
  ])('%s with the hold marker on it is NOT deliverable', (status) => {
    expect(soCanRaiseDo(status, true)).toBe(false);
  });

  test('a null marker does not block a deliverable status', () => {
    expect(soCanRaiseDo('CONFIRMED', null)).toBe(true);
  });

  test.each(['draft', 'Draft', 'dRaFt', ' DRAFT '])('case and space do not admit %p', (status) => {
    expect(soCanRaiseDo(status.trim(), false)).toBe(false);
  });

  test.each([null, undefined, ''])('an unreadable status (%p) still offers the action', (status) => {
    expect(soCanRaiseDo(status, false)).toBe(true);
  });
});
