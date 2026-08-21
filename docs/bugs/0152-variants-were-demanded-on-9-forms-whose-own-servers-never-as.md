## Variants were demanded on 9 forms whose own servers never asked [high]

**Symptom (owner).** "明明是当我有 ProcessingDate 和 DeliveryDate 的时候，它才
compulsory，现在怎么变成就算没有 ProcessingDate，也强制要求我填写了？"

**Root cause — a default, not a rule.** `SoLineCard` declared
`variantsRequired = true`, commented "DEFAULT true so Consignment + any other
consumer is unchanged (owner 2026-07-14)". ELEVEN render sites exist; TWO passed
the prop, one passed false, and the other NINE silently inherited `true`.

Checked against each document's OWN route:
- `consignment-orders.ts:687` runs the check `procDate ? ... : []`; its PATCH
  (`:1267`) only collects offenders when `internalExpectedDd` is set. CONDITIONAL.
- `consignment-notes.ts` / `consignment-returns.ts` / `delivery-returns.ts` /
  `sales-invoices.ts` — `findIncompleteVariantLines` appears **zero** times. The
  requirement was pure client-side invention.

**Fix.** CO New + Detail pass the conditional; the eight downstream cards pass
false (the rule `DeliveryOrderNewV2` already states for the DO). **The default is
gone** — `variantsRequired` is a REQUIRED prop, so the next caller that forgets
it fails to compile instead of shipping a field the operator cannot get past.

**NOT changed.** `SalesOrderNew`'s confirm gate (`:1443`, owner 2026-08-08,
HC-SO-2607-008) requires category axes on CONFIRM "date or no date". That is an
explicit owner decision; its marker and its gate disagree and that is an owner
call, recorded not silently resolved.

**Superseded, same day.** That owner call was made and the gate is gone. The
block is now `if (processingDate)` — variant completeness is the PROCEED rule and
only the proceed rule (owner 2026-08-13: "只要是没有 proceed 这一张订单，其实都不
一定是需要填写的，除非它是 proceed 了"). The comment that replaced it records why:
running it at confirm "made a salesperson unable to book a real order from a real
customer who had not yet picked a seat height". Read this paragraph as history,
not as an open item; the code is `SalesOrderNew.tsx:1443-1455`, commit
`1d7d36cc`.

**Ref** - `fix/company-scope-sweep`, 2026-08-13.
