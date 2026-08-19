// The refusal has to survive the whole way out — composer -> enqueue -> route
// -> response key -> the surface that renders it. Every hop is a place it can
// be dropped back into silence, and the two ends are in DIFFERENT PACKAGES with
// no compiler between them: the backend writes `acNotSent` into a JSON body and
// the frontend reads it off an untyped response. Nothing but this file makes
// those two strings the same string.
//
// Same source-anchored style as soLocationGateWiring.test.ts — the LOGIC is
// unit-tested in src/scm/lib/ac-preflight.test.ts and
// src/scm/lib/autocount-outbox.test.ts; this makes sure a refactor cannot
// quietly unhook it.
import { describe, expect, test } from 'vitest';
import soRouteRaw from '../src/scm/routes/mfg-sales-orders.ts?raw';
import poRouteRaw from '../src/scm/routes/mfg-purchase-orders.ts?raw';
import outboxRaw from '../src/scm/lib/autocount-outbox.ts?raw';
import gateRaw from '../src/scm/lib/so-confirm-gate.ts?raw';
import feModuleRaw from '../../frontend/src/vendor/scm/lib/ac-not-sent.ts?raw';
import feSoRaw from '../../frontend/src/pages/scm-v2/SalesOrderNew.tsx?raw';
import fePoRaw from '../../frontend/src/pages/scm-v2/PurchaseOrderNew.tsx?raw';

/* Line endings, for the reason soLocationGateWiring.test.ts records: these are
   source-TEXT anchors and a CRLF checkout must not turn a wired-up repo red. */
const n = (s: string) => s.replace(/\r\n/g, '\n');
const soRoute = n(soRouteRaw);
const poRoute = n(poRouteRaw);
const outbox = n(outboxRaw);
const gate = n(gateRaw);
const feModule = n(feModuleRaw);
const feSo = n(feSoRaw);
const fePo = n(fePoRaw);

/** The one key. If this string moves, every assertion below moves with it. */
const KEY = 'acNotSent';

describe('the refusal reaches the operator', () => {
  test('the SO create route returns it on the response, not only to the queue', () => {
    expect(soRoute).toContain(`.problems`);
    expect(soRoute).toContain(`{ docNo, ...(${KEY}.length ? { ${KEY} } : {}) }`);
  });

  test('every PO create route returns it too — all three of them', () => {
    /* POST /, POST /from-sos and PATCH /:id/confirm. A fourth appearing without
       the key is a purchase order that can be refused in silence again. */
    const enqueues = poRoute.match(/enqueuePoCreate\(/g) ?? [];
    expect(enqueues.length, 'a new enqueuePoCreate callsite must also return acNotSent').toBe(3);
    expect((poRoute.match(new RegExp(KEY, 'g')) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('the enqueue returns the refusal rather than swallowing it', () => {
    /* The two create enqueues both hand `noteReadFailure`'s answer back. The
       shape that produced the defect was `await noteReadFailure(...); return
       false;` — the composer's verdict computed, filed, and dropped. */
    expect((outbox.match(/return \{ queued: false, problems \};/g) ?? []).length).toBe(2);
    /* Both CREATE enqueues keep the answer. The third caller (enqueueEdit, at
       the bottom of the file) discards it on purpose — an edit has no create
       response to hang a sentence on, and it is recorded as deferred rather
       than silently counted as done. This pins the split so neither side of it
       can move without a reader noticing. */
    const kept = outbox.match(/const problems = await noteReadFailure\(/g) ?? [];
    const dropped = outbox.match(/\n\s+await noteReadFailure\(/g) ?? [];
    expect({ kept: kept.length, dropped: dropped.length }).toEqual({ kept: 2, dropped: 1 });
  });

  test('the confirm gate asks ac-preflight, not a rule of its own', () => {
    expect(gate).toContain("import { acAgentProblem } from './ac-preflight'");
    /* The old third opinion. Its return is the whole bug: `agent` alone, any
       text, satisfied a gate whose whole purpose was HC-SO-2607-008's
       "Unassigned". */
    expect(gate).not.toContain('blank(facts.salespersonId) && blank(facts.agent)');
  });
});

describe('the two packages agree on the key', () => {
  test('the frontend reads the same string the backend writes', () => {
    expect(feModule).toContain(`export const AC_NOT_SENT_KEY = '${KEY}'`);
    expect(soRoute).toContain(KEY);
    expect(poRoute).toContain(KEY);
  });

  test('both desktop create surfaces render it, through the one module', () => {
    for (const [name, src] of [['SalesOrderNew', feSo], ['PurchaseOrderNew', fePo]] as const) {
      expect(src, `${name} must read the response through ac-not-sent.ts`)
        .toContain('acNotSentProblemsOf(res)');
      expect(src, `${name} must use the shared title, not one of its own`)
        .toContain('acNotSentTitle(');
      expect(src, `${name} must not colour a successful save as an error`)
        .toContain('AC_NOT_SENT_TONE');
    }
  });

  /* NAMING WHAT THIS DOES NOT COVER, because a wiring test that overstates its
     reach is how the next reader comes to trust something untrue. Two SO create
     surfaces are NOT wired yet — the mobile wizard (MobileNewSO) and the POS
     handover — and the DRAFT -> live transition returns a response object built
     inside its command, so it carries no key either. They are recorded as
     deferred, not as done; this test asserts the count so that "all four" can
     never be claimed by accident. */
  test('the wired surfaces are exactly the two named ones', () => {
    expect(feSo).toContain('acNotSentProblemsOf');
    expect(fePo).toContain('acNotSentProblemsOf');
  });
});
