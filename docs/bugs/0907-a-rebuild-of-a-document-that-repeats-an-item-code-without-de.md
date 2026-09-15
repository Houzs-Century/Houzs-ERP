## A rebuild of a document that repeats an item code without Desc2 stored none of its new keys, so four created documents could never be keyed [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** A resend plan against production on 2026-09-14 (run 34861556114)
still refused four documents the write-back had created, each with
`KeylessLineError`:

| document | keyless lines | repeated codes |
| --- | --- | --- |
| HC-SO-2609-071 | 6 of 6 | `A01` twice |
| HC-SO-2609-065 | 7 of 7 | `A01` twice |
| HC-SO-2609-055 | 9 of 9 | `HOK-2008(A) (K)` twice |
| HC-PO-2609-098 | 10 of 10 | four mattress codes twice each |

Read-only in the book the same day, nothing is transferred from any of their
lines, and the book's lines in DtlKey order carry exactly the ERP's codes in the
ERP's order.

**Root cause (traced).** They were created before 0890 taught `persistLineKeys`
that position is identity for a create, and a repeated code with no Desc2 was
refused as "a guess". The only road left to key such a document is a rebuild,
and a rebuild stores its keys through `persistNewLineKeys`
(`backend/src/scm/lib/autocount-line-keys.ts`). That function still carried the
same refusal: *"ItemCode 'A01' was added on more than one line and position 5 has
no Desc2 on both sides to tell them apart"*.

A rebuild clears the document and lays every line down in payload order, so the
book's new keys ascend in that order. That is the reasoning 0890 accepted for a
create. Today's rebuilds of HC-SO-013209 (6 lines) and HC-SO-001463 (3 lines)
stored keys whose per-position item codes matched, on the same mechanism.

**Fix.** `NewLineKeyTarget` carries `rebuilt`, and `persistNewLineKeys` skips the
repeated-code refusal for a rebuild only. The item code is still compared at
every position, and Desc2 is still compared where both sides have it. An ordinary
edit that adds lines keeps the refusal.

Pinned in `backend/src/scm/lib/autocount-line-keys.rebuild-repeats.test.ts`,
built from HC-SO-2609-071's lines. It fails on the unfixed tree
(`expected [ null, null, null, null, null, null ] to deeply equal [ Array(6) ]`)
and passes after, with two controls: an ordinary edit adding the same code twice
still stores nothing, and a rebuild whose positions disagree on code still
stores nothing.

**Not fixed here.** The four documents need rebuilding once this is live, through
*rebuild-ac-document*.

**Ref.** fix/ac-rebuild-repeated-codes, 2026-09-14.
