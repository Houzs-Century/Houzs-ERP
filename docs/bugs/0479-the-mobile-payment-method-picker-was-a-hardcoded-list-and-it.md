## The mobile payment-method picker was a hardcoded list, and it still offered a retired method [medium]

<!-- area: Sales orders + pricing -->

**白话.** 手机上改一笔已记录的付款时，「Method」那一格是写死在程式里的四个选项 ——
里面还有「Installment（分期）」，那个在 2026-06 就已经停用了（分期现在记法是
Method 选 Merchant，再选几个月的分期方案）。同一张单里旁边的「银行 / 分期方案 /
线上方式」三格都是从后台维护的清单读出来的，只有 Method 这一格没有跟上，所以后台
怎么改都影响不到它。

另外那份「离线备用清单」（网路慢或后台还没回来的时候先顶着显示的那份）也旧了两边：
付款方式多了一个已停用的「Installment」，银行少了三家 —— **Pinelabs、AEON、HSBC** ——
这三家在真实收据上都会出现，同事在那个当下**根本选不到**。现在两份都对齐了，而且是
直接对着当初那支 0037 迁移档去比对，以后再改就会自动抓出来。

**Symptom.** On the mobile recorded-payment edit sheet, the Method dropdown
offered `Installment` — deactivated as a top-level method by mig 0037 — and
could never offer anything Maintenance added or renamed. On a cold or offline
load, the Bank dropdown on BOTH surfaces was missing Pinelabs, AEON and HSBC.

**Root cause (traced in source, not guessed).** Two hand-written copies of a
database table.

1. `frontend/src/mobile/RecordedPayments.tsx` rendered its Method select from a
   literal `["Cash","Merchant","Online","Installment"]`, while the three
   sub-pickers beside it (Bank / Plan / Online type) already read the live
   catalog via `withStoredOption(optionsOrFallback(...))`. The file had every
   tool to do it right and this one picker was simply never converted with the
   others. It also carried its own byte-identical copy of
   `PAYMENT_METHOD_CODE_TO_VALUE`.
2. `FALLBACK_OPTIONS` (`vendor/scm/lib/so-dropdown-options-queries.ts`) is what
   `optionsOrFallback` returns whenever the API is loading or answers zero rows,
   so it is what every surface shows on a cold load. Its `payment_method` still
   listed `Installment`; its `payment_merchant` held nine banks while mig 0037
   seeds twelve.

**Fix.** The Method picker reads the catalog like its siblings, with
`withStoredOption` so a grandfathered stored value stays selectable — the reason
that helper exists is documented in the file: a controlled `<select>` whose
value matches no option displays its FIRST option while state holds the real one,
which once showed "MBB" beside a correctly-derived Account Sheet of "PBB".
`CODE_TO_PAY_METHOD` now imports the shared map instead of retyping it.
`FALLBACK_OPTIONS.payment_method` is the three selectable methods;
`payment_merchant` is mig 0037's twelve banks in its own order.

**Also removed: a stale re-guard that was one edit from biting.**
`MobileNewSO.tsx` re-checked a scanned payment method against a `PAY_METHODS`
array built from `FALLBACK_OPTIONS`, applied ON TOP of a value `reconcilePayment`
(`vendor/scm/lib/scan-prefill.ts`) had ALREADY snapped against the live catalog
with `snapValue` and which returns `null` rather than a bad method. **Stated
honestly: it dropped nothing, because the static list happened to be a superset
of the live one.** It was a latent hazard, not a live loss — and it is the exact
pattern that file's own header records removing for customer type and building
type, with the reason written out: *"Re-guarding against a stale hardcoded list
is what silently dropped valid scanned values on mobile."*

**Two comments corrected, one that could not be.**
`backend/src/scm/routes/so-dropdown-options.ts` told the operator, in a 409 they
actually read, that *"Payment methods are a fixed set of three"* while the gate
it emits consults `PAYMENT_METHOD_CORE_VALUES`, which has held **four** since
2026-08-13; its neighbouring comment still claimed `Installment` was
"intentionally unprotected and may be deactivated", which stopped being true the
same day. Both now say what the code does: three choosable, four protected.
**Mig 0037's own header asserts the same dead fact** — *"The code-side protected
set was reduced 4 -> 3"* — and it is NOT corrected, deliberately: the migration is
applied, `pg-migrate` tracks it by checksum, and editing an applied file's body
reports DRIFT and blocks the deploy. The correction lives in
`docs/modules/sales-order.md` and here instead.

**Guard proved RED before being trusted.**
`frontend/src/vendor/scm/lib/so-dropdown-options.fallback.test.ts` — `git stash`
of the whole fix fails **5 of its 7**. It PARSES mig 0037 for both the
deactivated method and the seeded bank list rather than restating them, so a
later migration that changes either set fails it until the fallback moves too;
it asserts its own parsers matched, so a verdict over nothing cannot read as a
pass; and it source-scans `RecordedPayments.tsx`, because "where does this list
come from" is invisible to a render test — a hardcoded list that happens to
match today renders identically to a live one.

**Ref.** `fix/mobile-payment-methods-from-db`, 2026-08-20.
