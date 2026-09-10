/* The PATCH that edits a payment must reach the ledger.
 *
 * WHY A SOURCE TEST. What must be true here is that a CALL is present in one
 * handler and absent from another, and these handlers are Supabase-backed with
 * no binding in this suite. The behaviour itself — reverse the old entry, book
 * the new one, and do neither when nothing the ledger cares about moved — is
 * pinned against the real poster in `src/acc/payment-repost.test.ts`. What
 * that suite cannot see is whether the ROUTE ever calls it, and that is
 * exactly the thing this change is: for a year the handler wrote the row and
 * stopped. Same technique, same reason, as tests/soOverCollection.test.ts.
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

describe('editing a payment moves its journal entry', () => {
  test('the source loaded (a silent empty glob must not pass)', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("mfgSalesOrders.patch('/:docNo/payments/:id'");
  });

  test('the PATCH handler re-posts the edited payment', () => {
    expect(handlerBody('patch', '/:docNo/payments/:id'))
      .toContain('repostSoPaymentBestEffort');
  });

  /* It must be handed BOTH sides. Given only the new row it cannot tell an
     amount correction from an approval-code typo, and would either re-post
     every edit or none. Scoped to the CALL, not the handler: `before` and
     `next` are both in scope for a hundred lines around it, so asserting over
     the whole handler would pass on a call that hands over neither. */
  test('it is given the payment as it was, and as it now stands', () => {
    const body = handlerBody('patch', '/:docNo/payments/:id');
    const at = body.indexOf('repostSoPaymentBestEffort');
    expect(at, 'the re-post call is not in this handler').toBeGreaterThan(-1);
    const call = body.slice(at, body.indexOf(');', at) + 2);
    for (const arg of ['id,', 'docNo,', 'companyId:', 'before,', 'next']) {
      expect(call, `the re-post call omits ${arg}`).toContain(arg);
    }
  });

  /* The four columns the ledger reads must all be in `next`. Dropping
     `merchant_provider` from it, say, would silently book every card payment
     to the generic EDC transit instead of the acquirer's own account — and
     would ALSO drop it from the UPDATE_PAYMENT audit, since one object now
     feeds both. */
  test('every column the ledger reads is in the object handed over', () => {
    const body = handlerBody('patch', '/:docNo/payments/:id');
    const at = body.indexOf('const next = {');
    expect(at, 'the handler builds no `next` object').toBeGreaterThan(-1);
    const next = body.slice(at, body.indexOf('};', at) + 2);
    for (const col of ['paid_at:', 'method:', 'merchant_provider:', 'amount_sen:']) {
      expect(next, `the edited row omits ${col}`).toContain(col);
    }
  });

  /* Deleting is a different event and keeps its own hook — its contra is dated
     TODAY, because removing a payment happens today, while an edit corrects a
     mistake made on the original's date. Mixing the two would silently change
     where a delete's reversal lands. */
  test('DELETE still goes through its own hook, not the edit path', () => {
    const body = handlerBody('delete', '/:docNo/payments/:id');
    expect(body).toContain('afterSoPaymentRemoved');
    expect(body).not.toContain('repostSoPaymentBestEffort');
  });

  test('the POST that creates a payment is not re-posting either — it books once', () => {
    const body = handlerBody('post', '/:docNo/payments');
    expect(body).not.toContain('repostSoPaymentBestEffort');
  });
});
