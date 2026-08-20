## A service case raised on a phone had no survey address, and its product category was free text over a maintained list [medium]

<!-- area: Service cases (ASSR) -->

**What staff saw.**

1. 用手机开的服务单，做完之后**客户收不到满意度调查**，因为单上根本没有email —
   要有人事后再补上去。
2. 手机上的「产品类别」是**自己打字**的。电脑上是一排固定的选项（床垫 / 床架 /
   沙发…）。打错一个字，电脑那边的筛选就多出一个只有一张单的分类，而且这张单在
   报表里算「没有分类」。

**Root cause: the phone and the desktop send different things to the same
endpoint.** Same class as
`docs/bugs/0463-the-phone-re-implemented-three-mail-center-rules-the-desktop.md`.

**1. `customer_email` was never in the mobile create payload.** Desktop's
`CreatePanel` sends it; `MobileServiceCase.tsx`'s `create` mutation sent
`doc_no`, `items`, `complaint_issue`, `issue_category`, `ref_no` and
`complained_date` and nothing else. It matters because
`backend/src/routes/assr.ts` picks the CSAT recipient as
`email_for_survey || customer_email` when a case reaches `completed` — so a
phone-raised case had no survey address at all, and the survey silently did not
go out (the send is fire-and-forget and skips when there is no recipient).

**2. `service_category` is a maintained multi-select, and the phone bound it as
`type: "text"`.** Desktop edits it with `CategoryChips` over
`GET /api/assr/lookups/product-categories` and sends an **array**; mobile sent a
**string** typed by hand.

The backend accepts both shapes, so this looked cosmetic. It is not, and the
mechanism is worth reading once: `resolveCategories`
(`backend/src/services/assr.ts`) resolves each token against
`assr_product_categories` (mig 0112) by slug or name. A token it does not
recognise is deliberately KEPT in the flat display string — so a legacy value is
never silently discarded — but it gets **no row** in `assr_case_categories`. That
join table is what every count and breakdown reads, because a comma-joined string
cannot count a Bedframe+Mattress case once on each side. So a typed value loses
twice, quietly: it becomes its own bucket in desktop's category filter
(`splitCategories` at the list column), and the case is uncategorised for
reporting.

**The "is it legacy?" question, answered rather than assumed.**
`backend/src/routes/assr.ts` calls the intake form's `issue_category` the
replacement for "the older service_category-driven flow", which reads like a
retirement notice. Checked before acting: `service_category` has a live
admin-maintained lookup, a live join table, a live desktop chips editor on the
detail page, a live list column and filter, and desktop's intake still sends it.
What was replaced is its INTAKE/triage role, not the column. The two answer
different questions — `issue_category` is WHAT WENT WRONG, `service_category` is
WHICH PRODUCT — so the fix is the picker, not deleting the write.

**The fix.** No backend change. One shared module now owns the rule and both
surfaces import it:

| rule | lives in | imported by |
|---|---|---|
| the lookup endpoint, `splitCategories`, which chips exist, what a toggle produces | `frontend/src/lib/assrProductCategories.ts` | `frontend/src/pages/ServiceCases.tsx` **and** `frontend/src/mobile/MobileAssrCategoryChips.tsx` |

Desktop's local `splitCategories` and its inline extras/toggle expressions were
DELETED in favour of the import, so the two cannot drift. Mobile gained a
`chips` field type on `EditableAcc` whose save path sends the array.

**A file-size note, because it shaped the diff.**
`frontend/src/mobile/MobileServiceCase.tsx` was sitting exactly ON its recorded
ceiling (3,381 lines), which may only fall. Two blocks were extracted to pay for
the new field and the picker — `assr-case-fields.ts` (the `get` dual-reader and
the pure formatters) and `MobileAssrSoField.tsx` (the SO typeahead). Both were
untestable inside the screen and now have tests of their own; the screen came out
at 3,376.

**Why CI never caught it.** `MobileServiceCase.tsx` had no test file at all.
Eleven tests now cover both surfaces' payload shapes, each proven failing against
the unfixed tree first: `expected undefined to be null` for the missing
`customer_email` key, and the phone never once requesting
`/api/assr/lookups/product-categories`.

**Ref.** branch `fix/mobile-service-case-parity` (2026-08-21).
