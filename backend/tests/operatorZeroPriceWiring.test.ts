// ----------------------------------------------------------------------------
// 'operator-zero' is reachable ONLY from the ERP line editor's explicit claim.
//
// The behaviour is tested in src/scm/lib/operator-zero-price.test.ts. What this
// file pins is the WIRING, because the failure mode is not a wrong verdict — it
// is the mode becoming reachable without the claim, which no unit test over the
// engine could ever see. Same idiom as soProceedRefusalWiring.
//
// Three ways that could happen, all asserted against:
//   1. the flag is read loosely, so a stray truthy value authors a free line;
//   2. the mode is selected without checking the price is actually 0, making it
//      a general "trust me" switch;
//   3. a POS session reaches it — the POS cannot state intent, and its 0 is the
//      documented "not provided" case the drift gate already carves out.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutes from '../src/scm/routes/mfg-sales-orders.ts?raw';
import recompute from '../src/scm/lib/mfg-pricing-recompute.ts?raw';
import salesOrderDetail from '../../frontend/src/pages/scm-v2/SalesOrderDetail.tsx?raw';

/** Source with comments stripped — the comments deliberately quote the shapes
 *  this file forbids in code. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SO = code(soRoutes);
const RECOMPUTE = code(recompute);
const EDITOR = code(salesOrderDetail);

describe("operator-zero wiring", () => {
  test('the route selects the mode only on a strict claim, at a zero price, off the POS', () => {
    expect(SO).toMatch(/!posTablet\s*&&\s*clientUnit === 0\s*&&\s*it\.zeroPriceIntended === true/);
  });

  test('the mode is never selected anywhere else in the route', () => {
    expect(SO.match(/'operator-zero'/g) ?? []).toHaveLength(1);
  });

  test('the ERP line editor sends the claim, and only at zero', () => {
    expect(EDITOR).toMatch(/unitPriceCenti === 0 \? \{ zeroPriceIntended: true \}/);
  });

  /* The migrated-document arm must stay exclusive to migrated documents: it
     suppresses selling surcharges, which an operator-authored zero must not. */
  test('operator-zero does not read as a migrated document', () => {
    expect(RECOMPUTE).toMatch(/isMigratedTrust\s*=\s*trustOperatorSelling === 'including-zero'/);
    expect(RECOMPUTE).not.toMatch(/isMigratedTrust[^\n]*operator-zero/);
  });

  /* The drift gate is untouched by this change and stays that way. */
  test('the drift rejects are still present', () => {
    expect((SO.match(/error:\s*'pricing_drift'/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
