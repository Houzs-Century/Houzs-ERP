## BUG CLASS - optional-param-noop: an optional argument that decides something [high]

**The shape** - a parameter is OPTIONAL, and its ABSENCE changes an answer: a
gate, an exemption, a scope, a threshold, a default that is not neutral. Every
call site that does not pass it keeps the OLD behaviour, with no compile error,
no failing test, and no runtime signal. The rule exists, is correct, is tested,
and applies only where somebody remembered to reach it.

**Worked example, and why the class is written down** - `itemCode` on
`missingVariantAxes` / `missingConfirmVariantAxes`
(`backend/src/scm/shared/so-variant-rule.ts`). PR #1763 (2026-08-09) added the
DIVAN ONLY gap exemption keyed on it and declared "itemCode threaded through the
backend gate and every desktop + mobile call site". It was not: the parameter
arrived as `itemCode?: string | null`, and FIVE of the thirteen call sites that
existed at that commit did not pass it —
`git grep -n "missingVariantAxes(\|missingConfirmVariantAxes(" 4f30a063 -- backend/src frontend/src`
lists all thirteen, and these five carry only two arguments:
`scm/lib/so-confirm-gate.ts:116`, `scm/shared/inventory-adjustment.ts:38`,
`pages/scm-v2/SalesOrderNew.tsx:1419`,
`pages/scm-v2/SalesOrderNewFromProducts.tsx:273`, and
`vendor/shared/inventory-adjustment.ts:42`. (This entry said "two" until
2026-08-13; the count was never enumerated, which is the same failure as the
claim it describes.) The backend confirm gate — the one that blocks a Processing
Date — was among them and was not closed until #2072 on 2026-08-13, so those
lines went on demanding a mattress Gap for a product that has none for FOUR
DAYS. The
2026-08-10 exemption for adjustable beds / trundle combos / double-decker bunks
was half-applied through the same hole. `git blame` shows the two halves of one
ternary, one updated and one not, four lines apart. The full trace is in the
DIVAN ONLY entry below.

**The remedy** - make the parameter REQUIRED, so the compiler enumerates the call
sites. Where "no value" must stay expressible, the caller passes an explicit
`null`: that reads as a decision instead of an oversight, and the safe reading of
`null` is asserted. Precedent already in the tree: `scopeToCompanyId`
(`scm/lib/companyScope.ts`) takes the company id as a REQUIRED positional
argument "so a caller cannot omit it and silently get every company - this
codebase has pooled Houzs and 2990 data twice for exactly that reason".

**Where the class was found and fixed** (sweep 2026-08-13, `backend/src` +
`frontend/src`; 1,197 functions carry an optional parameter, 36 of them on a
predicate/gate, and these are the ones whose absence flips the decision toward
the permissive side):

- `resolveExpectedBatchBySoItem` (`scm/lib/dropship-batch.ts`) - `opts?.onMultiPo`
  defaulted to `'latest'`, the PERMISSIVE direction. `'block'` is audit H3, which
  exists to REFUSE an ambiguous batch: a sofa line bound to two live POs gets one
  PO's number stamped on the OUT while the GRN may arrive under the other,
  stranding the drop-ship COGS at 0 forever. Three of the five callers omitted it.
  Now a required `{ onMultiPo }`; every call site states which question it asks.
- `validateItemCodes` (`scm/lib/validate-item-codes.ts`) - the catalog-membership
  REFUSAL gate. Unscoped it admits a code that exists only in the other company's
  SKU master (17 codes collided on production 2026-08-01); the scoped pricing read
  then prices the line at 0 and the order dies as `pricing_drift`.
- `findServiceLineCodes` (`scm/lib/service-line-guard.ts`) - the SERVICE-on-return
  409 gate. `mfg_products.code` is unique per company, so unscoped the same
  payload is cleared or refused depending on whose catalog row is found first.
- `resolveCandidateDoIds` (`scm/lib/do-line-remaining.ts`) - the invoiceable /
  returnable DO picker's cross-company leak guard (added after the 2026-08-10
  audit). A leak guard a third caller can switch off by saying nothing is a
  default, not a guard.
- `validatePasswordStrength` (`services/passwordStrength.ts` and its identical
  `frontend/src/lib/` copy) - `email?` gated the username-as-password check.
  Omit it and `Weisiang329-Strong!` passes every other rule and is accepted.

**Fix** - all six parameters are now required (`null` still expressible, and its
meaning asserted). Backend + frontend typecheck clean; no live call site was
missing an argument, which is the point - the hole was open, not yet fallen into,
and the compiler now holds it shut. Each carries a test that fails WITHOUT the
parameter: `backend/src/scm/lib/optional-param-noop.test.ts` (two companies, same
payload, opposite answers), `dropship-batch.test.ts` ('latest' and 'block'
disagree on one fixture, so no default can be right for both),
`services/passwordStrength.test.ts`, and `product-lookup-company-scope.test.ts`.
The compile half is pinned with `@ts-expect-error`, which `npm run typecheck`
reports as TS2578 the moment a parameter is made optional again.

**Deliberately LEFT, with the reason** - an optional parameter is fine when its
absence is the SAFE (stricter) direction AND a comment says so. Verified and kept:
`assertNotMirrored(docNo, fn, c?)` (no context - guard stays ACTIVE, stated),
`isLocked(..., unlockOverride = false)` (default keeps the lock),
`scmAreaGuard(area, opts?)` (`openRead` / `readInheritsFrom` absent = stricter),
`checkSiOverRemaining(..., excludeByDoItem?)` (absent = tighter cap),
`resolveForcedUnitCostSen({ operatorCostSen? })` (falls to weighted-avg then
last-known, never 0), `validateItemCodes`'s own `opts.requireActive` (opt-in
tightening; DO/SI/DR keep existence-only semantics on purpose).
`meetsProcessingDatePaymentGate(..., companyCode?)` is LEFT although its default
is the looser 30%: `processingDateThresholdFor` argues the case in full and the
blast radius was measured on prod (of 63 live SOs with a Processing Date, moving
2990 to 50% newly refuses zero). Also left: the ~40 read loaders carrying
`companyId?: number | null`, which are governed by companyScope's documented
degrade rule and are a different sweep - listed in the PR, not touched here.

**Lesson** - **an optional parameter is a silent default, and a default on a gate
is a policy.** When a new fact starts deciding something, adding it as `x?:` says
"apply this rule where convenient". Required says "apply it everywhere, and the
compiler will tell you where everywhere is." The failure mode has no symptom at
the call site that is wrong: it looks exactly like code written before the rule
existed, because it is.

**Ref** - `sweep/optional-param-noop`, 2026-08-13. Origin: PR #1763 and the
`fix/variant-itemcode-required` follow-up.

---
