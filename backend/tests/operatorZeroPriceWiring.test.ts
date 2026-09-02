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
import zeroPriceClaimSrc from '../../frontend/src/vendor/scm/lib/zeroPriceClaim.ts?raw';

/** Source with comments stripped — the comments deliberately quote the shapes
 *  this file forbids in code. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SO = code(soRoutes);
const RECOMPUTE = code(recompute);
const EDITOR = code(salesOrderDetail);
const CLAIM = code(zeroPriceClaimSrc);

describe("operator-zero wiring", () => {
  /* 2026-08-19 — both line writes now ask ONE helper, `erpLineTrust`. Editing a
     line to RM 0 worked while ADDING one at RM 0 silently took the catalogue
     price, because only the PATCH had the mode wired. A single decision cannot
     drift between the two the way two copies did. */
  test('the mode is selected in exactly ONE place: the shared helper', () => {
    expect(RECOMPUTE.match(/'operator-zero'/g) ?? []).toHaveLength(3); // the type, the helper, the trust condition
    expect(SO.match(/'operator-zero'/g) ?? []).toHaveLength(0);
  });

  /* 2026-09-02 — the helper gained a fourth arm, `soIsMigrated`, so the shape
     changed from one ternary to three guarded returns. The three failure modes
     in the header are unchanged and each still has its own assertion; the POS
     guard is now pinned as the FIRST statement, because it has to short-circuit
     the migrated arm too. */
  test('the helper demands a strict claim, at a zero price, off the POS', () => {
    expect(RECOMPUTE).toMatch(
      /\): TrustSelling => \{\s*if \(posTablet\) return false;/,
    );
    expect(RECOMPUTE).toMatch(
      /return unitPriceSen === 0 && zeroPriceIntended === true \? 'operator-zero' : true;/,
    );
  });

  /* 2026-09-02 — a MIGRATED order's stored price stands, zero included: the
     specials/fabric surcharge must not move a price AutoCount already carries.
     Pinned here because it is the arm that decides, and it must sit BELOW the
     POS guard — a POS session can state no intent about a migrated document. */
  test('a migrated order takes including-zero, and never from the POS', () => {
    expect(RECOMPUTE).toMatch(/if \(soIsMigrated\) return 'including-zero';/);
    expect(RECOMPUTE.indexOf('if (posTablet) return false;'))
      .toBeLessThan(RECOMPUTE.indexOf("if (soIsMigrated) return 'including-zero';"));
  });

  /* 2026-08-20 — SO CREATE joined them. It was the third path that prices a
     line and the only one that never asked, because it computed ONE boolean per
     request; a line marked RM 0 on a NEW order therefore took the catalogue
     price on both surfaces. Trace in zeroPriceCreatePath.test.ts. */
  test('ALL THREE line-pricing paths go through it — CREATE, ADD and PATCH', () => {
    expect(SO).toMatch(/erpLineTrust\(posTablet, clientUnit, it\.zeroPriceIntended, patchSoIsMigrated\)/);
    expect(SO).toMatch(/erpLineTrust\(addLinePosTablet, Number\(it\.unitPriceSen \?\? 0\), it\.zeroPriceIntended, false\)/);
    expect(SO).toMatch(/erpLineTrust\(createPosTablet, Number\(it\.unitPriceSen \?\? 0\), it\.zeroPriceIntended, false\)/);
    /* CREATE and ADD pass a LITERAL false, and that is the assertion: a line
       typed today has no AutoCount history, so its 0 means "not provided". Only
       the PATCH reads the order (`patchSoIsMigrated`), because only an existing
       order can be a migrated one. */
    expect(SO.match(/erpLineTrust\(/g) ?? []).toHaveLength(3);
  });

  /* 2026-08-20 — the claim moved out of this one file into
     frontend/src/vendor/scm/lib/zeroPriceClaim.ts, because SO CREATE and the
     whole mobile surface needed to make it too and had no way to. The rule is
     unchanged (claim only AT zero) and the assertion follows it to its new
     home; WHERE each surface calls it is pinned in the frontend's own
     zeroPriceClaimWiring.test.ts. */
  test('the RM 0 claim is made only AT zero, from ONE shared helper', () => {
    expect(CLAIM).toMatch(/unitPriceSen === 0 && authored \? \{ zeroPriceIntended: true \} : \{\}/);
    expect(EDITOR).not.toMatch(/const zeroPriceClaim\s*=/);
    expect(EDITOR.match(/zeroPriceClaim\(d\.unitPriceSen, true\)/g) ?? []).toHaveLength(2);
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
