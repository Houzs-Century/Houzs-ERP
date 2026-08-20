/* POST /:docNo/payments/:id/slip — the after-the-fact proof attach
   (owner 2026-08-07, "开放 backend 可以上传 balance payment proof").

   The route's whole reason to exist is a GATE ASYMMETRY, and an asymmetry is
   exactly what a later "tidy these three routes up" edit erases without
   noticing:

     PATCH  /payments/:id       → same-day window (it moves money)
     DELETE /payments/:id       → same-day window (it moves money)
     POST   /payments/:id/slip  → NO window (it moves none)

   Put the window back on the slip route and the feature is silently dead again
   for every balance whose receipt reaches the office on a later day — which is
   most of them, and was the original gap.

   WHY A SOURCE TEST: the correct behaviour here is the ABSENCE of a call, and
   the handler is Supabase/Postgres (`c.get('supabase')`), which this suite's
   environment does not bind. WHY import.meta.glob AND NOT readFileSync: this
   suite runs in workerd, where fs is not implemented; `?raw` is expanded by
   Vite at TRANSFORM time, in Node. Same technique, and same reasons, as
   tests/scheduleScopeRuling.test.ts. */

import { describe, expect, test } from 'vitest';

const sources = import.meta.glob('../src/scm/routes/mfg-sales-orders.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? '';

/** Strip comments so the assertions read CODE, not prose — the slip handler's
 *  own docblock explains the ruling and names the routes it differs from. */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Body of the handler registered for `method` + `path`, up to the next route
 *  registration. Slicing matters: asserting over the whole file would let
 *  PATCH's legitimate window call mask a re-added one on the slip route. */
const handlerBody = (method: string, path: string): string => {
  const marker = `mfgSalesOrders.${method}('${path}'`;
  const start = routeSource.indexOf(marker);
  expect(start, `${method.toUpperCase()} ${path} is not registered`).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
};

describe('payment proof attach route', () => {
  test('the source loaded (a silent empty glob must not pass)', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("mfgSalesOrders.post('/:docNo/payments/:id/slip'");
  });

  test('is NOT behind the same-day payment window', () => {
    const attach = handlerBody('post', '/:docNo/payments/:id/slip');
    expect(attach).not.toContain('paymentRowMutable');
    expect(attach).not.toContain('PAYMENT_WINDOW_CLOSED_ERROR');
  });

  test('the money routes it sits beside ARE behind that window', () => {
    // Without this, the assertion above could pass on a file that lost the
    // window entirely — which would be a far worse bug than the one it guards.
    expect(handlerBody('patch', '/:docNo/payments/:id')).toContain('paymentRowMutable');
    expect(handlerBody('delete', '/:docNo/payments/:id')).toContain('paymentRowMutable');
  });

  test('keeps the guards that are about ownership, not timing', () => {
    const attach = handlerBody('post', '/:docNo/payments/:id/slip');
    expect(attach).toContain('selfScopedSalesBlocked');
    expect(attach).toContain('payment_doc_mismatch');
  });

  test('writes only the slip — never an amount, method, date or collector', () => {
    const attach = handlerBody('post', '/:docNo/payments/:id/slip');
    // From the UPDATE's column list to the row selector that closes it. The
    // `.eq('id', id)` search starts at the update — the row LOAD above uses the
    // same selector, and anchoring on its earlier hit would slice backwards.
    const updateAt = attach.indexOf('.update({');
    expect(updateAt).toBeGreaterThan(-1);
    const update = attach.slice(updateAt, attach.indexOf(".eq('id', id)", updateAt));
    expect(update).toContain('slip_key');
    for (const moneyColumn of ['amount_sen', 'method', 'paid_at', 'collected_by']) {
      expect(update, `${moneyColumn} must not move on a proof attach`).not.toContain(moneyColumn);
    }
  });

  test('only a finished upload resolves, and it is promoted out of the reaper', () => {
    const attach = handlerBody('post', '/:docNo/payments/:id/slip');
    expect(attach).toContain("slipRowT.status !== 'uploaded'");
    expect(attach).toContain("status: 'promoted'");
  });

  test('records the swap in the audit ledger, both keys', () => {
    const attach = handlerBody('post', '/:docNo/payments/:id/slip');
    expect(attach).toContain("action: 'UPDATE_PAYMENT'");
    expect(attach).toContain("field: 'slipKey', from: before.slip_key, to: nextSlipKey");
  });
});
