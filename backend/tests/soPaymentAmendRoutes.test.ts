/* Both payment routes ask the reconciliation-aware question, not the old one.
 *
 * WHY A SOURCE TEST. What must be true is that a particular CALL replaced
 * another one in two handlers, and these handlers are Supabase-backed with no
 * binding in this suite. The RULE is pinned against the predicate
 * (src/scm/shared/soPaymentAmendRight.test.ts) and the READS against the fake
 * client (src/acc/payment-reconciled.test.ts); what neither can see is whether
 * the routes still call the old three-argument predicate, which would grant
 * Finance nothing and — worse — would go on allowing a same-day edit of a
 * payment that has already been reconciled. Same technique, same reason, as
 * tests/soOverCollection.test.ts.
 */
import { describe, expect, test } from 'vitest';

const sources = import.meta.glob('../src/scm/routes/mfg-sales-orders.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? '';

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const handlerBody = (method: string, path: string): string => {
  const marker = `mfgSalesOrders.${method}('${path}'`;
  const start = routeSource.indexOf(marker);
  expect(start, `${method.toUpperCase()} ${path} is not registered`).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
};

const GATED: ReadonlyArray<[string, string]> = [
  ['patch', '/:docNo/payments/:id'],
  ['delete', '/:docNo/payments/:id'],
];

describe('the payment edit and delete routes', () => {
  test('the source loaded (a silent empty glob must not pass)', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("mfgSalesOrders.patch('/:docNo/payments/:id'");
  });

  test('both ask paymentMayChange, which reads the reconciliation', () => {
    for (const [method, path] of GATED) {
      expect(handlerBody(method, path), `${method} ${path} does not check the reconciliation`)
        .toContain('paymentMayChange');
    }
  });

  /* The old call took three arguments and could not know about a permission or
     a reconciliation. A handler still calling it directly has silently opted
     out of both halves of this change. */
  test('neither calls the bare predicate any more', () => {
    for (const [method, path] of GATED) {
      expect(handlerBody(method, path), `${method} ${path} still calls paymentRowMutable directly`)
        .not.toContain('paymentRowMutable(');
    }
  });

  test('both pass the permission, and the same one', () => {
    for (const [method, path] of GATED) {
      const body = handlerBody(method, path);
      expect(body, `${method} ${path} does not pass the amend right`).toContain('mayAmend: hasHouzsPerm(c, SO_PAYMENT_AMEND)');
    }
  });

  /* The company must be the RESOLVED one. Scoping the reconciliation read to
     the wrong company would find no match and open every payment. */
  test('both scope the check to the resolved company', () => {
    expect(handlerBody('patch', '/:docNo/payments/:id')).toContain('companyId: co.companyId');
    expect(handlerBody('delete', '/:docNo/payments/:id')).toContain('companyId: delCo.companyId');
  });

  /* created_at, never paid_at: keying off the document date would let someone
     unlock an old payment by first editing its date to today. The rule predates
     this change and must survive it. */
  test('both still key the window off the day the row was KEYED', () => {
    for (const [method, path] of GATED) {
      const body = handlerBody(method, path);
      expect(body).toMatch(/createdDateMyt: mytDateOf\(/);
      expect(body).not.toMatch(/createdDateMyt: mytDateOf\(.*paid_at/);
    }
  });

  /* Adding a payment is FREE at any point (owner 2026-07-17) and must not have
     picked up a gate by proximity. */
  test('recording a payment is still ungated', () => {
    const body = handlerBody('post', '/:docNo/payments');
    expect(body).not.toContain('paymentMayChange');
    expect(body).not.toContain('SO_PAYMENT_AMEND');
  });
});

/* THE REASON, AND WHERE IT LANDS (owner 2026-09-10, docs/bugs/0782). A
   correction made on the amend right owes a reason and is a Finance event;
   a same-day fix is neither. Both facts hang off `via === 'amend'` from the
   predicate, and both routes have to act on it the same way. */
describe('a correction on the amend right owes a reason and is marked for Finance', () => {
  test('both routes refuse an amend-right correction that carries no reason', () => {
    for (const [method, path] of GATED) {
      const body = handlerBody(method, path);
      expect(body, `${method} ${path} does not gate on via === 'amend'`).toContain("via === 'amend'");
      expect(body, `${method} ${path} does not refuse a missing reason`).toContain('REASON_REQUIRED');
    }
  });

  test('both audit an amend-right correction with the amend source and the typed reason', () => {
    for (const [method, path] of GATED) {
      const body = handlerBody(method, path);
      expect(body, `${method} ${path} does not mark the audit row`).toContain('source: AMEND_SOURCE');
      expect(body, `${method} ${path} does not carry the reason into the audit`).toMatch(/note: (p\.reason|delReason)/);
    }
  });

  test('both put the ledger pair on the audit row', () => {
    for (const [method, path] of GATED) {
      expect(handlerBody(method, path), `${method} ${path} does not record what it did to the ledger`)
        .toContain('ledgerFieldChange(');
    }
  });

  /* The audit row can only carry the JE numbers if the ledger moved FIRST.
     Re-posting after the audit would record a correction with no entry on it
     every single time, and the report would read as if the books never moved. */
  test('the PATCH re-posts the ledger BEFORE it writes the audit row', () => {
    const body = handlerBody('patch', '/:docNo/payments/:id');
    const repost = body.indexOf('repostSoPaymentBestEffort(');
    const audit = body.indexOf("action: 'UPDATE_PAYMENT'");
    expect(repost).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(-1);
    expect(repost, 'the re-post runs after the audit, so the audit cannot carry the JE numbers').toBeLessThan(audit);
  });

  test('the PATCH accepts the reason in its body; the DELETE reads it off the query', () => {
    expect(routeSource).toMatch(/reason:\s+z\.string\(\)\.trim\(\)\.max\(500\)\.optional\(\)/);
    expect(handlerBody('delete', '/:docNo/payments/:id')).toContain("c.req.query('reason')");
  });
});
