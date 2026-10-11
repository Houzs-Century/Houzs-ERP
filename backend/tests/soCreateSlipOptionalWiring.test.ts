/* The payment slip is OPTIONAL on every Sales-Order path (Owner 2026-08-13:
   "其实 SalesOrder 所有的付款都不强制").

   THE INVARIANT THIS PINS: no SO route may refuse a payment for having no
   slip. The rule itself is unit-tested in
   src/scm/lib/so-create-payment-slips.test.ts; this file makes sure the create
   path is actually WIRED to it and that no hand-rolled requirement grows back
   beside it — which is exactly how the create path came to be stricter than
   POST /:docNo/payments for a month after that route relaxed on 2026-07-13.

   WHY A SOURCE TEST: the correct behaviour is partly the ABSENCE of a check,
   and these handlers run on Supabase/Postgres (`c.get('supabase')`), which this
   suite's environment does not bind. Same technique, and same reasons, as
   soLocationGateWiring.test.ts / paymentSlipAttach.test.ts. */

import { describe, expect, test } from 'vitest';

const sources = import.meta.glob('../src/scm/routes/mfg-sales-orders.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? '';

/** Strip comments so the assertions read CODE, not the prose explaining it. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const code = stripComments(routeSource);

describe('the source loaded', () => {
  test('a silent empty glob must not pass this file', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain('createSalesOrderCore');
  });
});

describe('SO create — payments[]', () => {
  test('parses through the SHARED schema, not a hand-rolled inline one', () => {
    expect(code).toContain('soCreatePaymentsSchema.safeParse(body.payments)');
    /* The old inline schema carried `uploadSessionId: z.string().min(1)` with
       no `.optional()`. Any re-inlined copy is the requirement coming back.
       Scoped to the create — paymentSlipAttachSchema further down the file
       legitimately requires one, because a slip IS that route's request. */
    const createBlock = code.slice(
      code.indexOf('let posPayments'),
      code.indexOf('const posPaymentsTotalCenti'),
    );
    expect(createBlock.length).toBeGreaterThan(50);
    expect(createBlock).not.toMatch(/uploadSessionId:\s*z\./);
  });

  test('resolves slips through the shared planner', () => {
    expect(code).toContain('claimedSlipSessionIds(posPayments)');
    expect(code).toContain('planCreatePaymentSlips(posPayments, slipById)');
  });

  test('a wholly slip-less create runs NO slip lookup at all', () => {
    /* Not an optimisation for its own sake: an unguarded `.in(…, [])` is a
       query whose result nobody can interpret, and it is the shape that
       tempts the next reader to reinstate "but there must be slips". */
    expect(code).toContain('if (sessionIds.length > 0) {');
  });

  test('a row with no slip is inserted with a null slip_key, not skipped', () => {
    expect(code).toContain('slip_key:           posPaymentSlipKeys![i] ?? null,');
    /* The scan receipt belongs to the SINGLE-deposit path; fanning it across
       split rows would stamp one photo onto payments it does not evidence. */
    const insertAt = code.indexOf('slip_key:           posPaymentSlipKeys![i]');
    expect(code.slice(insertAt - 400, insertAt)).not.toContain('receiptImageKey');
  });

  test('the slip promote is guarded, and never swallows the payment audit', () => {
    /* `.eq('upload_session_id', null)` is a filter nobody wrote on purpose. */
    expect(code).toContain('if (p.uploadSessionId) {');
    const promoteAt = code.indexOf("status: 'promoted', promoted_at:");
    const auditAt = code.indexOf("action: 'ADD_PAYMENT'", promoteAt);
    expect(promoteAt).toBeGreaterThan(0);
    expect(auditAt).toBeGreaterThan(promoteAt);
    // A slip-less payment is still a payment: the guard must not `continue`.
    expect(code.slice(promoteAt - 600, promoteAt)).not.toMatch(
      /if \(!p\.uploadSessionId\) continue;/,
    );
  });
});

describe('what a slip_required 400 is allowed to mean', () => {
  /* Three sites remain and none of them says "a payment needs a slip":
       create            → a CLAIMED session that does not resolve
       POST  /payments   → same, and only inside `if (p.uploadSessionId)`
       POST  …/:id/slip  → the attach endpoint, where a slip IS the request */
  test('there are exactly three, and no more', () => {
    expect((code.match(/error: 'slip_required'/g) ?? []).length).toBe(3);
  });

  test('POST /:docNo/payments only reaches it for a session the client SENT', () => {
    const at = code.indexOf('let paymentSlipKey: string | null = null;');
    expect(at).toBeGreaterThan(0);
    const block = code.slice(at, at + 900);
    expect(block).toContain('if (p.uploadSessionId) {');
    expect(block).toContain("error: 'slip_required'");
    // The gate is the session, never the amount.
    expect(block).not.toContain('amountCenti');
  });
});
