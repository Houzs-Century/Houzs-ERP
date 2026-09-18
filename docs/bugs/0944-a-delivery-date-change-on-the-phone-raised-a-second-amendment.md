## A Delivery Date change on the phone raised a second amendment for the Purchaser — every remarked line counted as changed [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, on the Amendments queue: 「为什么raise so amendment 还是会出来
两个审批？」. HC-SO-011410 showed A1 (Approver PURCHASER) and A2 (LOGISTIC), both created
20:15 MYT by the same requester with reason "ok". A1's quick view read "Line changes · 0 — No
line changes recorded"; A2 carried Delivery Date 29/09 → 26/09 and a SPEC card on `DISPOSE`
whose Was and Requesting sides were identical.

**Root cause (traced).** Read-only on production (`anogrigyjbduyzclzjgn`, 2026-09-16): A1 holds
one `SPEC` row on `JAGER-(K)` and A2 one `SPEC` row on `DISPOSE`; on both, `new_item_code`,
`new_qty`, `new_unit_price_sen` equal the stored line, `new_remark` / `new_discount_sen` are
NULL, and `new_variants` equals the stored `variants` **plus one key**:
`"remark": "账本原文: …"` — the line's remark column, copied in. The phone's
`buildVariants(l)` (`frontend/src/mobile/MobileNewSO.tsx`) writes `variants.remark = l.remark`
for the line-create body, and `amendmentLineChanged` compared `canonJson(buildVariants(l))`
with `canonJson(snap.variants)` — a stored blob that carries no `remark` key on any imported
line. So every line with a remark read as a spec change, `buildAmendmentLines` emitted a SPEC
row per remarked line, and the two-lane split sent the bedframe's to the Purchaser and the
service line's to Logistic: a header-only change became two approvals, one of them empty.
The AutoCount imports carry a remark on 4,519 company-1 lines (`账本原文: …`), so nearly every
phone edit of an imported order did this. Counted 2026-09-01 → 09-15: **42 such no-op lines in
47 amendments**; the **41 approved ones raised 32 PO amendments** to suppliers over changes that
did not exist (statuses APPROVED / REQUESTED), and the apply wrote `remark` into the variants of
**113 imported lines**. The desktop was not affected: its draft seed (`draftFromItem`) keeps the
remark as its own field and its signature (`amendmentLineSig`) never reads `variants.remark`.
An earlier fix of the same class (owner 2026-07-16, "完全看不出有什麼變動申請？") removed the
header-cascade phantom; this one is the remark side channel.

**Fix.**
- Phone, at the source: `amendmentLineChanged` and `buildAmendmentLines` compare and send the
  variants through `amendmentVariants` (`vendor/scm/lib/so-amendment-line-diff.ts`, strips the
  `remark` key; `{}` reads as none); the remark is tested as its own field and rides `newRemark`.
  Pinned in `so-amendment-line-diff.test.ts`.
- Server, its own copy of the rule: `backend/src/scm/lib/amendment-noop-lines.ts` —
  `dropNoopAmendmentLines` drops a SPEC / QTY line on an existing line whose every carried field
  equals the stored line (variants compared without `remark`, canonical key order; an omitted
  field cannot make a change; ADD / REMOVE always kept; a failed read is `null` → 500). The
  submit route (`POST /mfg-sales-orders/:docNo/amendments`) runs it BEFORE the `amendment_empty`
  check and the lane split, so a lane with only no-op lines never opens; the lane preview runs
  the same two steps in the same order (its body now carries every field the test reads) and
  reports `droppedNoopLines`. `so-revision.ts`'s `classifyAmendmentKinds` compares variants the
  same way, so a remark-only blob difference no longer counts as `VARIANT` for the PO follow-up.
  Pinned in `amendment-noop-lines.test.ts` (rule; the HC-SO-011410 rows verbatim) and
  `routes/amendment-submit-noop.test.ts` (wiring + order on both handlers).
- NOT repaired here: the 32 PO amendments already raised and the 113 polluted `variants.remark`
  keys — both listed for the owner with options (harmless to stock: `computeVariantKey` reads an
  allow-list per group; harmful to purchasing's queue: suppliers were asked to confirm nothing).

**Ref.** `fix/amendment-phantom-spec-lines`, 2026-09-16. Module guide:
`docs/modules/so-amendment.md` §1–2. Ledger scaffold `scripts/new-bug.mjs` was absent on `main`
when this entry was written, so the number was taken by listing `docs/bugs/`.
