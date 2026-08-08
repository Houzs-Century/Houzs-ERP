import { describe, expect, test } from 'vitest';
import routeSource from '../src/scm/routes/mfg-sales-orders.ts?raw';

/* Owner rulings 2026-08-08 — every SO line is a catalog SKU (free text never
   saves), and CONFIRMED requires a salesperson, a venue and complete required
   variants. These pin the WIRING: the guards exist, sit on the right paths,
   and run before anything irreversible (inserts, PWP claims).

   Same source-anchored style as mfgSalesOrderAuthzBeforeLease.test.ts — the
   LOGIC is unit-tested in src/scm/lib/validate-item-codes.test.ts and
   src/scm/lib/so-confirm-gate.test.ts; this file makes sure a refactor cannot
   silently unhook them from the routes. */

const between = (hay: string, startAnchor: string, endAnchor: string): string => {
  const start = hay.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = hay.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `anchor not found after ${startAnchor}: ${endAnchor}`).toBeGreaterThan(start);
  return hay.slice(start, end);
};

describe('create path (createSalesOrderCore)', () => {
  test('the free-text refusal and the ACTIVE catalog guard run before ANY item work', () => {
    const head = between(routeSource, 'async function createSalesOrderCore', 'invalidQtyResponse');
    expect(head).toContain('findFreeTextSoLines(items)');
    expect(head).toContain('freeTextSoLineResponse(freeText)');
    expect(head).toContain('{ requireActive: true }');
  });

  test('the confirm gate runs on non-draft creates BEFORE any PWP claim (a reject burns nothing)', () => {
    const gateAt = routeSource.indexOf('collectSoConfirmProblems({');
    const claimsAt = routeSource.indexOf('const claimedPwpCodes: Array');
    expect(gateAt).toBeGreaterThan(0);
    expect(claimsAt).toBeGreaterThan(0);
    expect(gateAt, 'confirm gate must run before the PWP claim loop').toBeLessThan(claimsAt);
    // …and it is skipped for drafts.
    const gateBlock = routeSource.slice(gateAt - 600, gateAt);
    expect(gateBlock).toContain("asDraft !== true");
  });
});

describe('line mutations', () => {
  test('add-line requires a non-blank code and an ACTIVE catalog member', () => {
    const block = between(routeSource, "mfgSalesOrders.post('/:docNo/items',", "mfgSalesOrders.");
    expect(block).toContain("String(it.itemCode ?? '').trim()");
    expect(block).toContain('{ requireActive: true }');
  });

  test('PATCH refuses blanking the code, and requires ACTIVE only when the code CHANGES', () => {
    const block = between(routeSource, "mfgSalesOrders.patch('/:docNo/items/:itemId',", "mfgSalesOrders.");
    expect(block).toContain("item_code_required");
    expect(block).toContain("String(it.itemCode).trim() !== String(prev.item_code ?? '')");
    expect(block).toContain('{ requireActive: true }');
  });

  test('the amendment submit validates requested new_item_codes as ACTIVE catalog members', () => {
    const block = between(routeSource, "mfgSalesOrders.post('/:docNo/amendments',", 'Two-lane split');
    expect(block).toContain('newItemCode');
    expect(block).toContain('{ requireActive: true }');
  });
});

describe('scan draft dates', () => {
  test('a scan DRAFT is born with NO Processing Date and NO delivery date (owner 2026-08-08, 2990-SO-2608-007)', async () => {
    const scanSource = (await import('../src/scm/routes/scan-so.ts?raw')).default as string;
    const block = between(scanSource, 'function buildDraftSoBodyFromSlip', 'async function runScanJob');
    expect(block).toContain('const scanDelivDate: string | null = null');
    expect(block).toContain('const scanProcDate: string | null = null');
    // The old default pinned processing to the scan day whenever the slip
    // carried a future delivery date — make sure it cannot quietly return.
    expect(block).not.toContain('scanDelivDate ? scanToday : null');
  });
});

describe('status route', () => {
  test('DRAFT→CONFIRMED runs the confirm gate before the status write commits', () => {
    const block = between(routeSource, "mfgSalesOrders.patch('/:docNo/status',", 'const commitStatusChange');
    expect(block).toContain("fromNorm === 'DRAFT' && toStatus === 'CONFIRMED'");
    expect(block).toContain('soConfirmProblemsForDoc(sb, docNo)');
    expect(block).toContain('validationFailedBody(confirmProblems)');
  });
});
