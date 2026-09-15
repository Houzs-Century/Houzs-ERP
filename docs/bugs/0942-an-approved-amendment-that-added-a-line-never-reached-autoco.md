## An approved amendment that added a line never reached AutoCount [high]

<!-- area: AutoCount sync + write-back -->
<!-- status: fixed -->

**Symptom.** An SO amended to ADD a line sits on the AutoCount Sync page as
**Held back** with *"1 of N line(s) carry no AutoCount DtlKey"* (KeylessLineError),
and stays there through every five-minute sweep. The document is in the ERP with
the new line; the account book has neither the line nor any of the amendment's
other changes. HC-SO-012757, 2026-09-15: amendment A1 added a TRANSPORTATION
CHARGES service line (`line_no` NULL, no key); three edits were queued (09:28,
09:51, 09:55) and all three refused the same way.

**Root cause (traced).** `applySoAmendment` (`so-revision.ts`) inserts the ADD
line but returned only `{ soDocNo, revision }`, so the approve-so route
(`so-amendments.ts`) queued the write-back edit with no `newLineIds`.
`composeEdit` refuses a keyless line that is not declared new — it cannot tell a
just-added line from one whose backfill was missed, and guessing "new" would
append a duplicate into a live book — so the whole edit is refused as
KeylessLineError and nothing is sent. The manual SO edit route
(`mfg-sales-orders.ts` `queueAcSoEdit`) and POST /items already pass `newLineIds`;
the amendment path was the one add-a-line road that told AutoCount nothing.

**Fix.** `applySoAmendment` captures the inserted row id (`.select('id').single()`)
and returns `addedLineIds: string[]`; the approve-so route passes it as
`newLineIds` to `enqueueEdit`. The existing lines already carry keys, which is
the condition `composeEdit` requires before it honours a new line, so the added
line is appended and its key stored on the next drain. `so-revision.amendmentPrice.test.ts`
gains two cases — an ADD returns the new line's id, a SPEC-only amendment returns
`[]` — the ADD case proved RED on the unfixed return (`expected [] to deeply equal
[ '<id>' ]`) and GREEN after; the local fake was made to honour
`insert(...).select().single()` so it can be asserted at all.

**Ref.** fix/ac-amendment-add-line-key, 2026-09-15.
