## An added amendment line said Remark cleared and Discount cleared [low]

<!-- area: Sales orders + pricing -->

**Symptom.** Seen while building the amendment queue's quick view (owner
2026-09-14, 「SO / PO amendment需要单击打开 弹窗 像SO这样」): the card for
HC-SO-012757/A1, which ADDS one TRANSPORTATION CHARGES line, read "Discount
cleared" under the requested line — nobody had cleared anything; a new line has
no discount to clear. Read-only on production (`anogrigyjbduyzclzjgn`,
2026-09-15T05:55Z): A1's added line carries a 30-character remark and
`new_discount_sen = null`; of the 7 ADD lines ever raised, 7 carry no discount
(every one of them read "Discount cleared") and 5 carry no remark (those also read
"Remark cleared"). The same words showed on the amendment job card, the desktop
Sales Order amendment modal and the phone's "View changes" sheet.

**Root cause (traced).** `amendmentLineChangedFields`
(`frontend/src/vendor/scm/lib/so-amendment-line-diff.ts`) answered every field as
changed for a whole-line change: `if (change_type === 'ADD' || change_type ===
'REMOVE') return EVERYTHING`. The three renderers show the remark and discount rows
when that flag is set, and word an EMPTY requested value as a request to clear it
(`(new_remark ?? '').trim() ? … : 'Remark cleared'`, `new_discount_sen > 0 ? … :
'Discount cleared'`) — right for an edit of an existing line, wrong for a new
line, where empty means "none". On a REMOVE the Was side likewise struck through a
"Discount 0.00" the removed line never had. The printed amendment
(`amendment-pdf-map.ts`) was never affected: its ADD branch prints a remark only
when one is present and skips the flag. Observed with tests over the unfixed rule:
an ADD with no remark and no discount answered `remark: true, discount: true`, and
the quick view rendered "Discount cleared" for that line.

**Fix.** The one shared rule now flags the remark and the discount on an ADD only
when the new line carries one (non-blank remark, discount above 0), and on a
REMOVE only when the removed line had one; every other field of a whole-line
change is still a change. Because all three screens read that rule, all three stop
saying "cleared". Pinned by `so-amendment-line-diff.test.ts` ("an ADD with no
remark and no discount does not flag either as changed", "a REMOVE flags a remark
or discount only when the removed line had one" — both proved RED on the unfixed
rule — and "an ADD that does carry a discount flags it") and by
`AmendmentQuickView.test.tsx`, which asserts neither word renders for that line.

**Ref.** `feat/amendment-list-quick-view`, 2026-09-15.
