import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DO_NOT_INVOICEABLE_STATES,
  DO_NOT_INVOICEABLE_IN_LIST,
  DO_NOT_DELIVERED_STATES,
  doCountsAsInvoiceable,
  doCountsAsDelivered,
} from '../src/scm/shared/do-shipped-states';
import { siTransferRefusal } from '../src/scm/lib/do-line-remaining';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* A LOADED DELIVERY ORDER MAY BE INVOICED — owner, 2026-08-20.
 *
 *   「发票是invoice？等送完货了我们才自己convert to invoice啊」
 *   「我们自己开啊 manually开的不是吗」
 *
 * Asked directly whether the system should REFUSE it, he chose 不要拦 —— 人自己
 * 知道: the invoice is raised by hand, by someone who knows whether the goods
 * arrived, so the system does not second-guess them.
 *
 * THIS FILE EXISTS BECAUSE THE RULE HAS NOW BEEN REVERSED TWICE. #2485 opened
 * the invoice to LOADED by deleting a guard that named it; #2557 closed it again
 * as a side effect of a stock fix that was right about everything else; this
 * re-opens it. Nothing stopped either reversal, because the two rules lived in
 * different files and each looked locally correct. A third round is what this
 * test is for — it fails by NAME if someone folds LOADED back into the invoice
 * path, and the failure says which ruling it is undoing.
 *
 * The census is the other half of the honesty: check-do-integrity R4 (run
 * 32368212535) found ZERO delivery orders in LOADED in either company, so this
 * settles a rule rather than repairing an incident. */
describe('LOADED is invoiceable — the owner ruled, 2026-08-20', () => {
  test('the invoice-side refusal set is DRAFT and CANCELLED, and nothing else', () => {
    expect([...DO_NOT_INVOICEABLE_STATES]).toEqual(['DRAFT', 'CANCELLED']);
    expect(DO_NOT_INVOICEABLE_STATES as readonly string[]).not.toContain('LOADED');
  });

  test('doCountsAsInvoiceable says yes to LOADED and no to the two that block', () => {
    expect(doCountsAsInvoiceable('LOADED')).toBe(true);
    expect(doCountsAsInvoiceable('loaded')).toBe(true);
    expect(doCountsAsInvoiceable('DRAFT')).toBe(false);
    expect(doCountsAsInvoiceable('CANCELLED')).toBe(false);
  });

  test('the PostgREST literal the picker uses does not exclude LOADED', () => {
    expect(DO_NOT_INVOICEABLE_IN_LIST).toBe('("DRAFT","CANCELLED")');
    expect(DO_NOT_INVOICEABLE_IN_LIST).not.toContain('LOADED');
  });

  test('the create gate agrees — siTransferRefusal lets a LOADED delivery through', () => {
    expect(siTransferRefusal('LOADED')).toBeNull();
    expect(siTransferRefusal('DRAFT')?.error).toBe('do_not_confirmed');
    expect(siTransferRefusal('CANCELLED')?.error).toBe('do_cancelled');
  });

  /* THE OTHER RULING, which must NOT be collapsed into this one. #2557 fixed a
     real defect: a LOADED DO counted as delivered, so a full delivery was
     refused its own dispatch for over-delivering against itself. That half is
     untouched and this asserts it, because the tempting "cleanup" is to merge
     the two sets that agree on six of eight statuses. */
  test('the DELIVERED question still excludes LOADED — #2557 is not undone', () => {
    expect(DO_NOT_DELIVERED_STATES as readonly string[]).toContain('LOADED');
    expect(doCountsAsDelivered('LOADED')).toBe(false);
    expect(doCountsAsDelivered('DISPATCHED')).toBe(true);
  });

  test('the two sets differ, and differ by exactly LOADED', () => {
    const inv = new Set<string>(DO_NOT_INVOICEABLE_STATES);
    const del = new Set<string>(DO_NOT_DELIVERED_STATES);
    const only = [...del].filter((s) => !inv.has(s));
    expect(only).toEqual(['LOADED']);
    expect([...inv].filter((s) => !del.has(s))).toEqual([]);
  });

  /* The wiring, read from source: a caller that asks the engine for the
     INVOICE pool must not be handed the delivered one. Pinned as source facts
     because these routes need a live Postgres to run. */
  test('the Sales-Invoice route asks the engine for the invoiceable pool', () => {
    const si = read('backend/src/scm/routes/sales-invoices.ts');
    expect(si).toContain("resolveCandidateDoIds(sb, c.req.query('doIds'), activeCompanyId(c), 'invoiceable')");
    expect(si).not.toMatch(/doLineRemaining\([^)]*'delivered'\)/);
  });

  test('the returnable and unbilled paths still ask for the delivered pool', () => {
    expect(read('backend/src/scm/routes/delivery-returns.ts')).toContain("'delivered')");
    expect(read('backend/src/scm/routes/unbilled-deliveries.ts')).toContain("'delivered')");
  });
});
