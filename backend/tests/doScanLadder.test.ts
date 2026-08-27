// ----------------------------------------------------------------------------
// The scan ladder, as a set of PROPERTIES rather than a list of expected rows.
//
// The ladder used to be frontend-only, rendered by one page. It is now read by
// the SERVER too, because the no-login scan must decide the target status itself
// — a rung named in a request body is a rung an attacker picks. So the ladder's
// shape is a security property now, and these tests are about the shape:
//
//   · FORWARD ONLY. Every rung's target sits strictly further along than the
//     status it was computed from. Written as a walk over the ladder's own
//     derived order, so a rung ADDED tomorrow is covered without editing this
//     file — and a rung pointed backwards fails here rather than in production.
//   · SIGNED IS NEVER A TARGET (bug 0481: a button that wrote a delivered-
//     counting status and collected no signature, photo or GPS).
//   · EVERY TARGET IS A REAL scm.do_status MEMBER (bug 0530: a label the enum
//     does not define is a 22P02 that 500s the page, not an empty match).
//   · EVERY RUNG CARRIES ITS OWN LINE OF COPY, so adding one cannot leave the
//     operator with a button and no sentence.
//
// And the mirror: the frontend copy must be byte-identical to this one.
// check-shared-mirrors --strict enforces that in CI; this asserts it here too,
// because a drift found at test time names the file, and a drift found by the
// mirror check at merge time is one more round trip.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  doScanStep,
  doScanBlockReason,
  doScanConfirmation,
  doScanLadderOrder,
  doScanRungIndex,
} from '../src/scm/shared/do-scan-ladder';
import { DO_STATUSES } from '../src/scm/shared/do-shipped-states';

const ORDER = doScanLadderOrder();

describe('the ladder only ever points forward', () => {
  test('every rung lands strictly further along than where it started', () => {
    for (const from of ORDER) {
      const step = doScanStep(from, false);
      if (!step) continue;
      const a = doScanRungIndex(from);
      const b = doScanRungIndex(step.status);
      expect(b, `${from} -> ${step.status} is not on the ladder`).toBeGreaterThan(-1);
      expect(b, `${from} -> ${step.status} is not forward`).toBeGreaterThan(a);
    }
  });

  test('it starts at draft, has no repeats, and terminates', () => {
    expect(ORDER[0]).toBe('draft');
    expect(new Set(ORDER).size).toBe(ORDER.length);
    expect(doScanStep(ORDER[ORDER.length - 1], false)).toBeNull();
  });

  test('the order is DERIVED — it is exactly the walk, not a second list', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src/scm/shared/do-scan-ladder.ts'), 'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    /* A hand-typed rung array anywhere in this module would be a second
       declaration of the ladder. The only literal allowed is the starting rung. */
    expect(src).not.toMatch(/\[\s*'draft'\s*,\s*'loaded'/i);
    expect(ORDER).toEqual(['draft', 'loaded', 'dispatched', 'in_transit', 'delivered']);
  });
});

describe('what a rung may target', () => {
  test('SIGNED is never a target — bug 0481', () => {
    for (const from of [...ORDER, 'signed', 'invoiced', 'cancelled', 'nonsense']) {
      expect(doScanStep(from, false)?.status).not.toBe('SIGNED');
    }
  });

  test('every target is a real scm.do_status member — bug 0530', () => {
    for (const from of ORDER) {
      const step = doScanStep(from, false);
      if (step) expect((DO_STATUSES as readonly string[]).includes(step.status)).toBe(true);
    }
  });
});

describe('a rung is never silent, and never rendered without its warning', () => {
  test('every rung carries a non-empty label and note', () => {
    for (const from of ORDER) {
      const step = doScanStep(from, false);
      if (!step) continue;
      expect(step.label.trim().length).toBeGreaterThan(0);
      expect(step.note.trim().length).toBeGreaterThan(0);
      expect(doScanConfirmation(step.status).trim().length).toBeGreaterThan(0);
    }
  });

  test('the delivered rung names the evidence it does not collect', () => {
    const note = doScanStep('in_transit', false)!.note;
    expect(note).toContain('not a signed receipt');
    expect(note).toContain('no customer signature');
    expect(note).toContain('Proof of Delivery');
  });

  test('no step means a sentence, never nothing', () => {
    for (const s of ['signed', 'delivered', 'invoiced', 'cancelled', 'ON_HOLD', '', null]) {
      if (doScanStep(s, false)) continue;
      expect(doScanBlockReason(s, false)?.length ?? 0).toBeGreaterThan(0);
    }
    expect(doScanStep('loaded', true)).toBeNull();
    expect(doScanBlockReason('loaded', true)).toContain('on hold');
  });
});

describe('the mirror', () => {
  test('the frontend copy is byte-identical to the backend original', () => {
    const be = readFileSync(resolve(__dirname, '..', 'src/scm/shared/do-scan-ladder.ts'), 'utf8');
    const fe = readFileSync(
      resolve(__dirname, '..', '..', 'frontend/src/vendor/shared/do-scan-ladder.ts'), 'utf8',
    );
    expect(fe.replace(/\r\n/g, '\n')).toBe(be.replace(/\r\n/g, '\n'));
  });
});
