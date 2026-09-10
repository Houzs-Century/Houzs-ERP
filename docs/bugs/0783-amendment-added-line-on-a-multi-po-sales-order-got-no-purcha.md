## Amendment-added line on a multi-PO sales order got no purchase order and no warning [high]

**Symptom.** Owner 2026-09-10: an amendment that ADDS a product line to a sales
order could leave that line with no purchase order and say nothing — the missing
order is then found on delivery day. 「如果等到要送货的时候，我们才发现没有 order,
那就严重了」. He asked for it traced and fixed: 「要,查到底并修掉」.

**Root cause (traced).** `backend/src/scm/lib/so-revision.ts` `reviseBoundPo`
raises two operator warnings for an added line that reaches no purchase order —
"no supplier set" (was line 1314) and "supplier has no open PO on this sales
order" (was line 1321). Both were gated on `scopeCoversAll`
(`scopedPos.length === livePos.length`, was line 1219). The PO-Amendments confirm
calls the engine SCOPED to one PO (`routes/po-amendments.ts:403`,
`{ onlyPoId: amendment.po_id }`), so `scopedPos` is always 1 while `livePos` is
the whole bound set — meaning `scopeCoversAll` is FALSE on every sales order with
2+ live bound POs, and both warnings were suppressed there. A modern line-add is
only ever confirmed on that scoped path (the unscoped `approve-po` gate 409s for
lane rows — `routes/so-amendments.ts:1035`), so on any 2+-PO sales order the
warning was structurally silent. The `scopeCoversAll` gate was redundant as well
as harmful: the genuine sibling-PO case (an added line whose supplier owns a PO
this confirm did not scope) is already handled by the out-of-scope `continue`
below the warnings, so the two warning points are only ever reached for a line
with no covering PO anywhere. Proved RED first: a scoped confirm on a 2-PO SO
returned `res.warnings === []` for both the no-supplier and no-open-PO cases in
`so-revision.reviseBoundPo.test.ts`.

**Fix.** Removed the `scopeCoversAll` gate on both warnings (and its now-dead
declaration); the per-line supplier match against the full `livePos` already
decides a genuine gap, and the out-of-scope `continue` already defers a
sibling-PO line, so neither warning can false-alarm. A covered line stays silent,
an uncovered added line now warns regardless of how many POs the SO carries. Three
new tests in `so-revision.reviseBoundPo.test.ts` pin it: the two warning cases
(RED before, GREEN after) and a false-alarm guard (a line covered by a sibling PO
must stay silent — GREEN both before and after). Exposure sized read-only by
`backend/scripts/check-amendment-added-line-po-gap.mjs` +
`.github/workflows/amendment-added-line-po-gap.yml`. This is a visibility fix
only — no purchase order is auto-created and no PO coverage is changed.

**Ref.** fix/amendment-po-warn, 2026-09-10.
