## Submit amendment on a locked SO failed with the processing lock when only a colour changed [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-09-12, on `HC-SO-013497` (CONFIRMED, processing date
07/09/2026 passed): the fabric colour on a sofa line is now pickable, but
**Submit amendment request** answers

```
Save failed.
Processing date has passed — this Sales Order is locked. (Locked orders are what we PO to the supplier.)
```

"它应该是 submit amendment 啊，结果它不可以 save" — the operator changed one
line's colour and nothing else. Reproduced on staging (prod copy) in the browser;
the request that 409'd was NOT the amendment. It was the direct header PATCH the
desktop sends first:

```
PATCH /api/scm/mfg-sales-orders/HC-SO-013497
{"debtorName":"MR LIM","venueId":"28","address1":"26, JLN BU4/9 BANDAR UTAMA","version":1}
-> 409 {"error":"so_locked_processing"}
```

Three columns the operator never touched. The amendment POST never ran.

**Root cause (traced).** Stored row: `debtor_name = "MR LIM "`, `address1 =
"26, JLN BU4/9 BANDAR UTAMA "` — trailing spaces from the AutoCount import
(`venue_id` is NULL; the picker's self-heal adopts id 28 by name and is FREE, so
it is noise here, not the cause).

1. `withFrozenHeaderFieldsReverted` (`so-amendment-header.ts`) "reverted" each
   frozen key to `outValue(original[key])`, and `outValue` **trims**. The
   pristine payload it was then diffed against (`originalPayloadRef`,
   `SalesOrderDetail.tsx`) held the raw `h.debtor_name` — `"MR LIM "`.
   `diffHeaderPayload` deliberately does not trim, so `"MR LIM"` ≠ `"MR LIM "`
   and the untouched name was sent as an edit. Same for `address1`.
2. `lockedColumnsChanged` (`backend/src/scm/shared/so-field-policy.ts:335`)
   compared raw too, so `"MR LIM"` vs `"MR LIM "` counted as a genuine change
   to a CONTROLLED column (name / phone / email are CONTROLLED since
   2026-08-21) → 409.
3. The banner (`AMENDMENT_MODE_BANNER`) still told the operator that "Customer
   name, phone, email and the note save straight away" — three weeks stale
   against the policy table, so the failure also contradicted the screen.

This is the THIRD time "submit amendment on a locked SO is refused" has come
back through a different seam: `0488` (mobile omitted originals → revert wrote
NULL), `0815` (inch-mark item code), now trim. The common defect in 0488 and
this one is the revert itself: it must reproduce the seeded value byte for byte
or it becomes an edit.

**Fix.**
- The direct half now **drops** every amendable key instead of reverting it:
  `withoutFrozenHeaderFields(patch)` replaces
  `withFrozenHeaderFieldsReverted(patch, original)` in both surfaces
  (`SalesOrderDetail.tsx`, `MobileNewSO.tsx`). The server's lock diffs
  `col in updates`, so a column never sent cannot 409 — no value to reproduce,
  no `original` argument to get wrong. Pinned by
  `so-amendment-header.test.ts` (rewritten; includes the `"MR LIM "` case
  end-to-end through `diffHeaderPayload`).
- Backend `lockedColumnsChanged` trims both sides — a whitespace-only delta
  from ANY client is never a CONTROLLED change. Pinned by
  `backend/tests/soFieldPolicy.test.ts` ("ignores a whitespace-only
  difference"), proved RED on the unfixed predicate (1 failed | 24 passed).
- `AMENDMENT_MODE_BANNER` now says name / phone / email ride the amendment and
  the note / customer type / emergency contact save straight away; the test
  pins both halves.
- `docs/modules/sales-order.md` ⚠️ paragraph rewritten for the drop rule.

Frontend tests proved RED first (8 failed: 6 on the missing helper, 2 on the
banner), then green (42 passed across the three files).

**Ref.** fix/so-locked-colour-goes-to-amendment, 2026-09-12.
