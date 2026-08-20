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
import feModuleRaw from '../../frontend/src/vendor/scm/lib/ac-not-sent.tsx?raw';
import feSoRaw from '../../frontend/src/pages/scm-v2/SalesOrderNew.tsx?raw';
import fePoRaw from '../../frontend/src/pages/scm-v2/PurchaseOrderNew.tsx?raw';
/* The four TRANSFERRED documents, added 2026-08-20. Their verdict is the other
   one — the document IS in the accounts and a field on it is not — and it
   travels the same five hops through different files, so it needs the same
   referee. */
import doRouteRaw from '../src/scm/routes/delivery-orders-mfg.ts?raw';
import grnRouteRaw from '../src/scm/routes/grns.ts?raw';
import piRouteRaw from '../src/scm/routes/purchase-invoices.ts?raw';
import siRouteRaw from '../src/scm/routes/sales-invoices.ts?raw';
import preflightRaw from '../src/scm/lib/ac-preflight.ts?raw';
import feDoRaw from '../../frontend/src/pages/scm-v2/DeliveryOrderNewV2.tsx?raw';
import feGrnRaw from '../../frontend/src/pages/scm-v2/GrnNew.tsx?raw';
import fePiRaw from '../../frontend/src/pages/scm-v2/PurchaseInvoiceNew.tsx?raw';
import feSiRaw from '../../frontend/src/pages/scm-v2/SalesInvoiceNew.tsx?raw';

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
const doRoute = n(doRouteRaw);
const grnRoute = n(grnRouteRaw);
const piRoute = n(piRouteRaw);
const siRoute = n(siRouteRaw);
const preflight = n(preflightRaw);
const feDo = n(feDoRaw);
const feGrn = n(feGrnRaw);
const fePi = n(fePiRaw);
const feSi = n(feSiRaw);

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
      /* The WHOLE behaviour goes through the one module — not just the
         wording. A surface that read the key itself would be free to pick its
         own title, its own tone, and its own answer to "show anything on an
         empty list", which is the drift do-next-step.ts records. */
      expect(src, `${name} must show it through ac-not-sent.tsx, not by hand`)
        .toContain("notifyAcNotSent(notify, res, '");
      expect(src, `${name} must not build the dialog itself`)
        .not.toContain('acNotSentTitle(');
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
    expect(feSo).toContain('notifyAcNotSent');
    expect(fePo).toContain('notifyAcNotSent');
  });
});

/* ── THE OTHER VERDICT, AND THE SAME FIVE HOPS ───────────────────────────────
   A conversion's problems say "it IS in the accounts, and this field on it is
   not". Same key, same component, DIFFERENT sentence — and the sentence is the
   part that must not drift, because the not-sent wording would tell an operator
   their goods receipt is ERP-only when the book already holds it.

   Every assertion here is a hop a refactor can silently unhook, and the two
   ends are still in different packages with no compiler between them. */
describe('a transferred document that arrived incomplete reaches the operator too', () => {
  const CODE = 'ac_sent_incomplete';

  test('the two packages agree on the code, letter for letter', () => {
    expect(preflight).toContain(`export const AC_SENT_INCOMPLETE = '${CODE}'`);
    expect(feModule).toContain(`export const AC_SENT_INCOMPLETE_CODE = '${CODE}'`);
  });

  test('the enqueue composes the sentences rather than only queueing them', () => {
    /* The composer is asked; this file does not re-decide what is missing. */
    expect(outbox).toContain('acNotCarriedProblems(own.notCarried');
    expect(preflight).toContain('export function acNotCarriedProblems(');
  });

  test.each([
    ['delivery order', () => doRoute],
    ['goods receipt', () => grnRoute],
    ['purchase invoice', () => piRoute],
    ['sales invoice', () => siRoute],
  ])('the %s route returns them on the response, not only to the queue', (_name, src) => {
    const s = src();
    expect(s).toContain('problems:');
    expect(s).toContain(`${KEY}.length ? { ${KEY}`);
  });

  test.each([
    ['DeliveryOrderNewV2', () => feDo, 'Delivery order'],
    ['GrnNew', () => feGrn, 'Goods receipt'],
    ['PurchaseInvoiceNew', () => fePi, 'Purchase invoice'],
    ['SalesInvoiceNew', () => feSi, 'Invoice'],
  ])('%s SHOWS them, through the shared frame', (_name, src, label) => {
    const s = src();
    /* Quote-agnostic: DeliveryOrderNewV2 is a double-quoted file and the
       import style is not what this test is about. */
    expect(s.replace(/"/g, "'")).toContain("from '../../vendor/scm/lib/ac-not-sent'");
    /* The shared helper, never a hand-rolled read of the key: what counts as
       "the accounts did not get it" and how it is worded must not be
       re-decided per screen. */
    expect(s).toContain('notifyAcNotSent(notify,');
    expect(s).toContain(label);
    expect(s).not.toContain('acNotSentProblemsOf');
  });

  test('the frame picks the title off the problems, so neither screen chooses it', () => {
    expect(feModule).toContain('export function acTitleFor(');
    expect(feModule).toContain('title: acTitleFor(problems, docLabel)');
    /* And the arrived-incomplete title must not claim the document is missing. */
    /* The RETURNED SENTENCE, not the block around it — the doc comment above
       it quotes the other title in order to explain why they differ, and a test
       that read the comment would forbid the explanation. */
    const decl = feModule.slice(feModule.indexOf('export function acSentIncompleteTitle('));
    const returned = decl.slice(decl.indexOf('return '), decl.indexOf(';', decl.indexOf('return ')));
    expect(returned).not.toContain('have not got it');
    expect(returned).toContain('reached the accounts');
  });
});
