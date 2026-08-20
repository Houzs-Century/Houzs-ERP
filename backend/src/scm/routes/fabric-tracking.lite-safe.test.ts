import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* GET /fabric-tracking/lite is the openRead display/pick read (SO fabric dropdown
 * + PC-Order detail) added 2026-08-20 to end the `[rbac 403] GET /fabric-tracking`
 * errors: those surfaces are gated on scm.sales.* / scm.consignment.*, not
 * products, so they could not read the full (cost-bearing) fabric list.
 *
 * The WHOLE safety of opening that path is that the lite SELECT carries NO cost
 * or stock. If a later edit adds one of those columns back to the lite handler,
 * opening the path silently becomes a within-company leak of fabric cost / SOH /
 * usage to sales staff — the exact thing area-guard warns about for /inventory.
 * These pin the invariant at the source, and pin that the guard actually opens
 * the lite path (openReadPaths) while the full read stays gated. */

const routeSrc = readFileSync(
  fileURLToPath(new URL('./fabric-tracking.ts', import.meta.url)),
  'utf8',
);
const indexSrc = readFileSync(
  fileURLToPath(new URL('../index.ts', import.meta.url)),
  'utf8',
);

// Isolate the /lite handler body (from its registration to the next route
// registration) so the assertions cannot accidentally read the FULL GET '/'
// handler above it, which legitimately selects the cost columns.
function liteHandlerBody(): string {
  const start = routeSrc.indexOf("fabricTracking.get('/lite'");
  expect(start, "the /lite handler must exist").toBeGreaterThan(-1);
  const after = routeSrc.indexOf('fabricTracking.', start + 1);
  return routeSrc.slice(start, after === -1 ? undefined : after);
}

const SENSITIVE_COLUMNS = [
  'price_sen',
  'soh_sen',
  'po_outstanding_sen',
  'last_month_usage_sen',
  'one_week_usage_sen',
  'two_weeks_usage_sen',
  'one_month_usage_sen',
  'shortage_sen',
  'reorder_point_sen',
  'lead_time_days',
  // the supplier NAME (supplier_code, the display dual-code, is deliberately kept)
  'supplier,',
];

const REQUIRED_DISPLAY_COLUMNS = [
  'fabric_code',
  'fabric_description',
  'supplier_code',
  'price_tier',
  'sofa_price_tier',
  'bedframe_price_tier',
];

describe('GET /fabric-tracking/lite — never exposes cost/stock', () => {
  it('selects NONE of the sensitive cost/stock columns', () => {
    const body = liteHandlerBody();
    for (const col of SENSITIVE_COLUMNS) {
      expect(body, `lite must not select ${col}`).not.toContain(col);
    }
  });

  it('still selects the display + price-tier columns the pickers need', () => {
    const body = liteHandlerBody();
    for (const col of REQUIRED_DISPLAY_COLUMNS) {
      expect(body, `lite must select ${col}`).toContain(col);
    }
  });

  it('stays company-scoped, exactly like the full read', () => {
    expect(liteHandlerBody()).toContain('scopeToCompany');
  });
});

describe('the guard opens ONLY the lite path, not the full read', () => {
  it('openReadPaths lists /fabric-tracking/lite', () => {
    expect(indexSrc).toContain(
      'scmAreaGuard("scm.procurement.products", { openReadPaths: ["/fabric-tracking/lite"] })',
    );
  });

  it('does not blanket-openRead the whole fabric-tracking mount', () => {
    // A bare `openRead: true` here would open the FULL cost-bearing read.
    expect(indexSrc).not.toContain(
      '/fabric-tracking/*", scmAreaGuard("scm.procurement.products", { openRead: true })',
    );
  });
});
