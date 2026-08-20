## The desktop stage picker offered stages the case does not run, and printed different words for them than the phone [medium]

<!-- area: Service cases (ASSR) -->

**白话.** 一张服务单如果是「自己人上门修 / 客户拿回来」，就没有供应商那两步 ——
手机上很正确，只显示 5 步。可是电脑版的「Change to」那个下拉，旁边明明写着
「Step 2 / 5」，一点开却给你 7 个选项，把不该出现的供应商那两步也列进去了。选下去
系统就把单子推到一个这张单根本走不到的阶段。

还有一件事更容易让人对不上帐：同一个阶段，电脑版写「Verification」，手机、客户看的
网页和打印出来的报告写「Under Verification」；电脑版写「Delivery / Service」，其他
地方写「Pending Delivery / Service」。同事在电脑上讲一个词，在手机上看到另一个词，
以为是两回事。

**Symptom.** On an internal-resolution case (`field_service_own` /
`return_visit`) the desktop detail's Workflow card counted `Step n / 5` and its
"Change to" dropdown beside it listed all **7** stages, including the two
supplier-only ones the case never enters. Separately, four stages read with
different words on desktop than on every other surface: `Review`, `Solution`,
`Verification`, `Delivery / Service` against the canonical `Pending Review`,
`Pending Solution`, `Under Verification`, `Pending Delivery / Service`.

**Root cause (traced in source, not guessed).** Two instances of one thing —
the desktop page holding its own copy of an answer the shared layer already had.

1. `WorkflowCard` (`frontend/src/pages/ServiceCases.tsx`) is HANDED a `stages`
   prop that `getActiveStages()` has already filtered through the shared
   `isStageActive` — and it used that prop only for the `Step {curIdx + 1} / {n}`
   counter. The `<select>` two lines below mapped the module-level, UNFILTERED
   `DETAIL_STAGES`. So the counter and the dropdown, rendered inside the same
   flex row, answered from different lists. Mobile
   (`MobileServiceCase.tsx`) maps `activeAssrStages(resolutionMethod, stage)`
   and never had it.
2. `DETAIL_STAGES` was a sixth hand-written copy of the stage vocabulary.
   `vendor/scm/lib/assr/stages.ts` reads every `long` from
   `assr-stage-labels.ts`; this table typed its own, and four had drifted. It is
   the same mechanism `assr-stage-labels.ts`'s own header documents — a screen
   that could not reach the layer holding the answer wrote the answer down.

**Fix.** The picker maps the `stages` prop. `DETAIL_STAGES` is now
`ASSR_STAGES.map(...)`, so the page owns no stage word at all; the funnel-dot
caption (`desc`), which was the only column genuinely local to it, moved onto
`AssrStageDef` beside the row it captions.

**Deliberately NOT changed, and raised for the owner instead:** the desktop
select still appends `<option value="voided">`, which mobile has never offered —
so a case can be Voided only from a desktop. Whether the phone should be able to
void is a business question, not a defect, and the owner's standing rule is to
loosen rather than restrict. It is left exactly as it shipped.

**Guard proved RED before being trusted.**
`frontend/src/vendor/scm/lib/assr-stage-labels.canonical.test.ts` gains three
tests; all three fail on the unfixed tree — `DETAIL_STAGES ... to contain
'ASSR_STAGES'`, `has re-grown a hand-typed "Supplier Pickup / Return"`, and `the
stage picker maps the UNFILTERED DETAIL_STAGES again`. Source-scanned for the
reason that file already states: the page is 8,845 lines and cannot be imported
without a router and a query client.

**One trap worth recording, because the first draft of the guard passed against
the unfixed tree.** The window it read was `source.indexOf(';', at)` — and the
first `;` after `const DETAIL_STAGES` sits INSIDE the type annotation
(`{ id: AssrStage; short: string; ... }`), so the test inspected six characters
of a type and called the table clean. A source-scan is only as honest as the
slice it scans; assert your guard fails first.

**Ref.** `fix/assr-constant-drift`, 2026-08-21.
