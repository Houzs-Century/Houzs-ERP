import { describe, expect, test } from 'vitest';
import rawHistorySource from '../src/scm/routes/mfg-sales-orders/history.ts?raw';

/*
 * DEV-16: the SO History drawer merges in the rows of the POs / DOs / invoices
 * raised from the order, so "PO created" shows up beside the SO's own entries.
 * It merges LIFECYCLE moves only. A PO's line and supplier-date edits are
 * UPDATE rows, and letting them through buries the SO's own timeline under its
 * children's churn.
 *
 * Source-shape, like soChildReadsCompanyScoped: the handler is a Supabase
 * builder chain the light suite cannot execute, so what is pinned is the filter
 * being present and the list it filters on.
 */

const SRC = rawHistorySource.replace(/\r\n/g, '\n');

const actionList = (): string[] => {
  const m = SRC.match(/const RELATED_AUDIT_ACTIONS = \[([^\]]*)\]/);
  expect(m, 'RELATED_AUDIT_ACTIONS not found').not.toBeNull();
  return [...m![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
};

describe('GET /:docNo/related-audit-log', () => {
  test('reads entity_audit_log filtered to RELATED_AUDIT_ACTIONS', () => {
    const start = SRC.indexOf("mfgSalesOrders.get('/:docNo/related-audit-log'");
    expect(start).toBeGreaterThan(-1);
    const rest = SRC.slice(start);
    const handler = rest.slice(0, rest.search(/\nmfgSalesOrders\.(get|post|patch|put|delete)\(/));
    expect(handler).toContain("from('entity_audit_log')");
    expect(handler).toMatch(/\.in\('action', RELATED_AUDIT_ACTIONS\)/);
  });

  test('keeps the create / confirm / send / cancel / amendment moves and drops edits', () => {
    const actions = actionList();
    expect(actions).toEqual(expect.arrayContaining(['CREATE', 'POST', 'SEND', 'CANCEL', 'AMENDMENT_PO_APPROVED']));
    expect(actions).not.toContain('UPDATE');
    expect(actions).not.toContain('UPDATE_DETAILS');
  });
});
