import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SO_UNDELIVERABLE_STATUSES, soCanRaiseDo } from './so-deliverable-states';

/* THE PAIR, REFEREED. Same shape as do-shipped-states.canonical.test.ts, and for
 * the same reason: check-shared-mirrors.mjs only FAILS a diverging pair it
 * considers unrefereed, and `refereed()` is a text heuristic that a nearby
 * unrelated test can satisfy by accident. A vendored copy with no byte
 * comparison behind it is a second copy wearing the badge of one.
 *
 * This module exists BECAUSE the rule was written twice in two shapes. Letting
 * its own two copies drift would be the same defect one layer down. */
describe('the two copies of this module are the same file', () => {
  test('backend/src/scm/shared/so-deliverable-states.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/so-deliverable-states.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/so-deliverable-states.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  /* A byte comparison passes for the wrong reason if either read came back
     empty, so prove the file is real and carries what it is imported for. */
  test('the set is the three the server denies, and nothing else', () => {
    expect([...SO_UNDELIVERABLE_STATUSES]).toEqual(['DRAFT', 'CANCELLED', 'ON_HOLD']);
  });
});

describe('soCanRaiseDo', () => {
  /* THE REGRESSION THIS FILE IS FOR. READY_TO_SHIP is written by the stock
     allocator with no human involved, so a rule that excludes it takes the
     button away by itself. It was excluded, for weeks, by an allow-list of one
     in the Sales Order list's row drawer. */
  test('READY_TO_SHIP can raise a Delivery Order', () => {
    expect(soCanRaiseDo('READY_TO_SHIP')).toBe(true);
  });

  test.each([
    'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED',
  ])('%s is deliverable', (status) => {
    expect(soCanRaiseDo(status)).toBe(true);
  });

  test.each(['DRAFT', 'CANCELLED', 'ON_HOLD'])('%s is NOT deliverable', (status) => {
    expect(soCanRaiseDo(status)).toBe(false);
  });

  /* The list payload has been observed handing back "Draft" / "draft" / "DRAFT"
     for the same row — the CTA it feeds normalised case for exactly that
     reason, and a predicate that did not would re-open the hole. */
  test.each(['draft', 'Draft', 'dRaFt', ' DRAFT '])('case and space do not admit %p', (status) => {
    expect(soCanRaiseDo(status.trim())).toBe(false);
  });

  /* Never OVER-BLOCK on an absence. The server makes the same choice
     (firstUndeliverableSo lets a row with no readable status fall through): the
     server is the gate, this decides whether to OFFER, and offering something
     the server then refuses in plain language beats hiding something it would
     have taken. */
  test.each([null, undefined, ''])('an unreadable status (%p) still offers the action', (status) => {
    expect(soCanRaiseDo(status)).toBe(true);
  });
});
