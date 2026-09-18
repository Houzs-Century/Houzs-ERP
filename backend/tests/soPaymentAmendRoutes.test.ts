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
import { soRouterSource } from './lib/so-router-source';

const sources = import.meta.glob(['../src/scm/lib/so-payment-reason.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sourceEnding = (suffix: string): string => Object.entries(sources).find(([p]) => p.endsWith(suffix))?.[1] ?? '';
const routeSource = soRouterSource();
/* The one rule the four routes ask (docs/bugs/0888) — pinned by its own unit
   test; read here only to prove the routes reach it and that it reads the key. */
const ruleSource = sourceEnding('so-payment-reason.ts');

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const handlerBody = (method: string, path: string): string => {
  const marker = `mfgSalesOrders.${method}('${path}'`;
  const start = routeSource.indexOf(marker);
  expect(start, `${method.toUpperCase()} ${path} is not registered`).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/);
  const registration = next === -1 ? rest : rest.slice(0, next);
  /* A route registered by NAME — `mfgSalesOrders.post(path, someHandler)`,
     the exported-handler shape the contract tests drive (docs/bugs/0927) —
     has its body under `export const someHandler = async`, not here. */
  const named = /^[^\n]*',\s*([A-Za-z0-9_]+)\);/.exec(registration);
  if (named) {
    const at = routeSource.indexOf(`export const ${named[1]} = async`);
    expect(at, `${method.toUpperCase()} ${path}: handler ${named[1]} is not defined in the route file`).toBeGreaterThan(-1);
    const tail = routeSource.slice(at + 1);
    const end = tail.search(/\n(export const [A-Za-z0-9_]+ = async|mfgSalesOrders\.(get|post|patch|put|delete)\()/);
    return stripComments(end === -1 ? tail : tail.slice(0, end));
  }
  return stripComments(registration);
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
     picked up a WINDOW gate by proximity. Since docs/bugs/0888 it reads the
     key — literally, for the reason a holder owes — but never through the
     wildcard-honouring read that opens a door. */
  test('recording a payment is still ungated by the window', () => {
    const body = handlerBody('post', '/:docNo/payments');
    expect(body).not.toContain('paymentMayChange');
    expect(body).not.toContain('hasHouzsPerm(c, SO_PAYMENT_AMEND)');
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
      expect(body, `${method} ${path} does not answer the rule's refusal`).toContain('owed.refusal');
    }
  });

  test('both audit an amend-right correction with the amend source and the typed reason', () => {
    for (const [method, path] of GATED) {
      const body = handlerBody(method, path);
      expect(body, `${method} ${path} does not carry the rule's audit mark`).toContain('owed.audit');
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

/* EVERY payment action by a ROLE holding the right owes a reason (owner
   2026-09-14, docs/bugs/0888: 只要是有关 collection payment 的，我或有权限的用户
   做的动作都要记录写 reason). Four routes, one reading of the key — LITERAL, so
   the Owner's wildcard is not a holder — one refusal, one audit mark, and the
   payment tagged on the row so the report can name who first recorded it. */
describe('a role that holds the right owes a reason on every payment action', () => {
  const ALL: ReadonlyArray<[string, string]> = [
    ['post', '/:docNo/payments'],
    ['patch', '/:docNo/payments/:id'],
    ['delete', '/:docNo/payments/:id'],
    ['post', '/:docNo/payments/:id/slip'],
  ];

  test('the add route resolves to the add, not the proof attach beside it', () => {
    expect(handlerBody('post', '/:docNo/payments')).toContain('paymentCreateSchema.safeParse');
    expect(handlerBody('post', '/:docNo/payments/:id/slip')).toContain('paymentSlipAttachSchema.safeParse');
  });

  test('all four ask the one rule, and the rule reads the key LITERALLY — the wildcard alone must not count', () => {
    for (const [method, path] of ALL) {
      expect(handlerBody(method, path), `${method} ${path} does not ask the rule`).toContain('paymentReasonRule(c,');
    }
    expect(ruleSource.length, 'the rule did not load — a silent empty glob must not pass').toBeGreaterThan(500);
    expect(ruleSource).toContain('holdsHouzsPermLiterally(c, SO_PAYMENT_AMEND)');
    expect(ruleSource).not.toContain('hasHouzsPerm(');
  });

  test("all four refuse a holder's write that carries no reason, in the holder's words", () => {
    for (const [method, path] of ALL) {
      expect(handlerBody(method, path), `${method} ${path} lets a holder through without a reason`)
        .toContain('if (owed.refusal) return c.json(owed.refusal, 400)');
    }
    expect(ruleSource).toContain('KEY_HOLDER_REASON_REQUIRED');
  });

  /* The literal read decides the REASON. The window is still opened by the
     wildcard-honouring read — a reconciled payment stays shut to everybody, and
     the Owner's `*` still corrects after the day (with a reason, as before). */
  test('the edit and the delete still open the window on the wildcard-honouring read', () => {
    for (const [method, path] of GATED) {
      const body = handlerBody(method, path);
      expect(body).toContain('mayAmend: hasHouzsPerm(c, SO_PAYMENT_AMEND)');
      expect(body).not.toContain('mayAmend: holdsHouzsPermLiterally');
    }
  });

  test('every route marks the audit row with the amend source and tags it with the payment', () => {
    expect(handlerBody('post', '/:docNo/payments')).toContain('auditSource: AMEND_SOURCE');
    for (const [method, path] of ALL.slice(1)) {
      const body = handlerBody(method, path);
      expect(body, `${method} ${path} does not carry the rule's audit mark`).toContain('owed.audit');
      expect(body, `${method} ${path} does not tag the payment`).toContain('paymentId: id');
    }
    expect(ruleSource).toContain('source: AMEND_SOURCE');
  });

  test('the add and the proof routes take the reason in their bodies, the same shape as the edit', () => {
    const shapes = routeSource.match(/reason:\s+z\.string\(\)\.trim\(\)\.max\(500\)\.optional\(\)/g) ?? [];
    expect(shapes, 'the create, edit and proof schemas should each carry the reason').toHaveLength(3);
  });
});
