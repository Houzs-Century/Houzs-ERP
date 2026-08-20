## A sofa could be added to a bedframe Consignment Order, because the rule saying it cannot lived inside another router's create handler [high]

<!-- area: Sales orders + pricing -->

**Symptom.** `POST /consignment-orders/:docNo/items` accepted a SOFA line on a
Consignment Order whose existing lines were BEDFRAME, and
`PATCH /:docNo/items/:itemId` accepted a swap into the same shape. Nothing
errored. The document was simply built, and the downstream consumers that assume
one main category per document (the consignment note, the sofa batch guard, the
AutoCount per-document item derivation) then worked on a shape they were never
designed for.

**The rule exists and is enforced elsewhere.** `so_sofa_no_other_main` — a sofa
may not share an order with a bedframe or a mattress (PR #519) — was written by
hand FIVE times and reached five of the eight places that can put a caller's item
code on a line:

| path | before |
| --- | --- |
| `mfg-sales-orders.ts` SO create | inline `normCat` + MAIN set |
| `mfg-sales-orders.ts` SO add-line / edit-line / tbc-swap | `soMainMixIntroduced` |
| `mfg-sales-orders.ts` SO **amendment submit** | **nothing** |
| `consignment-orders.ts` CO create | inline `normCat` + MAIN set |
| `consignment-orders.ts` CO **add-line** | **nothing** |
| `consignment-orders.ts` CO **edit-line** | **nothing** |

**Why nobody was careless.** The reusable form of the rule was a closure inside
`mfg-sales-orders.ts`'s create handler and a private `async function` further up
the same file. Neither was exported, so a person writing the CO line routes had
nothing to call and no way to see the rule existed. This is the same shape
PR #2374 closed on the unlinked-line money guard: INSERT paths guarded, EDIT path
not.

**The third hole was found by the check, not by hand.** `POST
/:docNo/amendments` is the only path that can ADD a line without going through
`POST /:docNo/items`. It validates every requested `newItemCode` against the
catalogue and says nothing about composition, and `applySoAmendment` does not
check it either — so an amendment could put a sofa on a bedframe order. Found by
the population test below, which listed it by name and line before anyone had
looked at that route.

**Reachability, verified rather than assumed.** `coHasDownstream` is not a
substitute for the missing gate: it only blocks once a DO or SI exists, and a
fresh CO has neither. A CO created bedframe-only is legitimately permitted by the
create path (no sofa is present), so the create gate has nothing to say about it.

**The fix.** `backend/src/scm/lib/main-mix.ts` is the one home. Three functions,
because there are genuinely three questions and collapsing them is the dangerous
move:

- `createMixRefusal` — FLAT ("does this document mix?"), for the create paths.
- `lineMixRefusal(sb, table, docNo, excludeItemId, newCode, companyId)` —
  DIFFERENTIAL ("does this change INTRODUCE a mix?"), parameterised on the line
  table so `mfg_sales_order_items` and `consignment_sales_order_items` share one
  body. Both tables carry `id`, `item_code`, `item_group`, `doc_no`, `cancelled`.
- `amendmentMixRefusal` — the differential form over a whole requested change set,
  using `applySoAmendment`'s own `SPEC | QTY | ADD | REMOVE` dispatch, applied at
  SUBMIT so the requester fixes it rather than the approver.

Grandfathering is preserved and is the point of the differential form:
`mixesSofaWithOtherMain(after) && !mixesSofaWithOtherMain(before)`. Porting the
create path's flat test onto the edit paths would have made every order written
before the rule existed permanently uneditable — worse than the bug.

**Three drifts resolved, each deliberately.**

1. *The classifier.* Both create paths carried a private `normCat` that is
   byte-for-byte `so-readiness.normCategory`, while `soMainMixIntroduced` used
   exact `=== 'SOFA'` on the catalogue enum. Unified on `normCategory`. No
   catalogued outcome changes: `scm.mfg_product_category`'s members are single
   uppercase tokens, none a substring of another
   (`backend/scripts/scale-pg-real-schema.mjs:36` plus migrations 0262-0265).
2. *The un-catalogued line.* `soMainMixIntroduced` read the catalogue ONLY, so a
   line whose code is not in this company's `mfg_products` classified as nothing
   at all and a real mix could be built on top of it. It now falls back to the
   stored `item_group` — the idiom every other category reader in the tree
   already uses for this exact situation (`delivery-planning.ts:573`,
   `delivery-zones.ts:342`, `so-display-branding.ts:133`). The fallback fires only
   when the catalogue row is missing, so it can never contradict the catalogue,
   and it cannot break the grandfathering: a more complete `before` set makes
   `mix(before)` MORE likely, i.e. an already-mixed document MORE editable.
3. *The sentence.* Three server sentences for one rule became one. No operator
   ever saw the difference — `authed-fetch.ts`'s curated `ERROR_CODE_MESSAGES`
   entry for `so_sofa_no_other_main` wins over `reason` on every surface that goes
   through `humanApiError` — but three sentences is how the fourth gets written
   slightly wrong.

**A read that failed is not an answer.** `soMainMixIntroduced` did
`const { data: lines } = await sb...` with no `error` bound. A failed read made
the order look EMPTY, an empty order can never mix, and the gate passed silently
— a checker that cannot match reporting a clean run. Every function now returns
`MixRefusal | null` instead of a boolean, so "it mixes" (400) and "we could not
tell" (409 `sofa_mix_check_unavailable`) stay distinct. The catalogue read is
verified by CONSEQUENCE: `validateItemCodes` has already proved, in the same
request and under the same company predicate, that every non-blank code is in
`mfg_products`, so a code that does not come back means the read failed.
`swallowed-read-baseline.json` falls by 3.

**The frontend pair, and the bug it was already causing.** The client check has
to stay a second implementation — it must refuse BEFORE a request, and it reads
free-text `itemGroup` where the server reads the catalogue enum. But it has two
forms for the same reason the server does, and `SalesOrderDetail.tsx` was using
the wrong one: a flat `hasSofaMixConflict` over the edited lines, sitting in front
of a differential server gate. An operator on a pre-rule mixed SO could not save
ANY change to it — not even a phone number — and the sentence blamed a rule the
server itself grandfathers. New `sofaMixIntroduced(before, after)` in
`so-variant-rule.ts`; the Detail pages use it, the New-order forms keep the flat
form because the server's create path asks the flat question.

**What pins it.** `backend/tests/mainMixOneHome.test.ts`. The population is not a
list of known call sites — that list is exactly what was wrong. It is every unit
in the two routers that runs `validateItemCodes`, which by construction is every
path where a caller-supplied item code lands on a line. A unit with the catalogue
guard and no composition rule fails and must be argued: the only recorded
exemption is `tbcSwapSofaCommandHandler`, which is SOFA -> SOFA by construction
(it refuses `prev.item_group !== 'sofa'` and refuses a replacement whose catalogue
category is not SOFA). Plus tree-wide checks that the error code is spelled in one
file, that the rule is defined once, that every caller is one of the two routers,
that each guard runs before its handler's write, and that neither differential
form has lost its `&& !`.

**Proven not vacuous.** Deleting the CO add-line guard turned the population test
red naming `POST /:docNo/items (line 1469)` — a handler it derived, not one it was
told about — and the call-site test named it as "the hole this change closed — it
has reopened". Deleting the `&& !` from `lineMixRefusal` turned five assertions
red across both suites, including "an ALREADY-MIXED CO still accepts an unrelated
line edit". Both were restored and the files verified byte-identical by SHA-256.

**Deliberately not done.** `MAIN_CATS` is still hand-copied three times
(`mfg-sales-orders.ts:1531`, `delivery-planning.ts:576`,
`so-display-branding.ts:44`) for the SO list's REPRESENTATIVE-category display,
which is a different question with a different answer, and
`so-readiness.MAIN_CATEGORIES` already exists to hold it. Same class, separate
change. `loadProductsByCodes` still discards its own read error
(`mfg-pricing-recompute.ts`); this file compensates by requiring every validated
code to come back, but the helper itself is used by many callers and is not in
scope here.
