## Transferred and newly created purchase orders kept no AutoCount line keys, so their amendments were refused [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The 0888 requeue plan (run 34823021667) refused nine purchase
orders: HC-PO-2609-087, -027, -032, -064 with `KeylessLineError`, and
HC-PO-2609-009, -086, -010, -079, -074 (and -068, approved later) with
`ItemCodeError ... maps to 2 AutoCount items and none belongs to supplier
400-H004`. AutoCount still holds HC-PO-2609-064's pieces as they were before its
amendment.

**What was ruled out (PROVEN, probe run 34826755295).** The amendments did not
lose the keys. Every line id on those POs is the id the create/transfer named in
its `lineWriteback`, created 2026-09-09..11, and the `po_revisions` snapshot each
approval took BEFORE applying (revision 1) already shows `linked_ac_dtlkey=null`
on every line. `reviseBoundPo` updates lines in place and never touches the key.
The keys were never stored.

**The ItemCodeError is the same defect.** `composeDetails` resolves an ItemCode
only for a line whose code will be SENT, and an edit sends it only for a KEYLESS
line (`keyedLinesKeepTheBooksItem`). All ten lines are keyless, so the refusal
fired before the keyless one. With keys, those lines never resolve a code.

**Root cause (traced).** `persistLineKeys` (`scm/lib/autocount-line-keys.ts`)
verifies before it stores, with checks written for CONVERSIONS, and applied them
to operations whose line order is constructed:

1. **Transfer (`so_to_po`).** It compared the book's ItemCode with the code the
   ERP composed. `AddSOToPOTransferDetail` copies the SALES line's item, so the
   book holds `HOK-2038 (A) (Q)` where the ERP composed `CELENE (A)-(Q)` —
   recorded verbatim on HC-PO-2609-089 — and the check fails for every
   supplier-coded product. Nine of the ten are transfers.
2. **Create (`create_po` / `create_so`).** A repeated item code with no Desc2 in
   the `lineWriteback` was refused as "a guess": HC-PO-2609-098 records
   `'AK-BASTION MATT (Q)' is on more than one line`; HC-PO-2609-064 sent
   `5536-1NA` twice. A create adds details in payload order and the host reads
   them back in DtlKey order, so position is identity.

Why nobody saw it: until 0813 (2026-09-11) the drain discarded the reason. Every
row above sent 2026-09-09..11 says `last_error: -`; rows from 2026-09-12 on
(HC-PO-2609-088/089/090, -098) record it. That the earlier ones failed on the
same check is LIKELY, not proven — their reason was never written anywhere.

**How wide (measured, run 34826755295 sections 7a/7b).** Since go-live, of the
documents whose create/transfer row was `sent`: 52 of 74 `so_to_po` and 4 of 27
`create_po` still hold keyless lines, and 4 of 75 `create_so` (two of them
recording `'A01' is on more than one line`).

**Fix.**
- A transfer proves book line N against the ERP row whose sales line IS
  `DtlKeys[N]` (the wire body's, so a `wait` row's drain-time backfill counts),
  reading both tables before writing; no ItemCode comparison. A payload whose
  keys are not in its lines' order (the 0889 pairing) stores nothing and says so.
- A create keeps the count and per-position ItemCode checks and skips the
  Desc2 / repeated-code refusals.
Pinned in `src/scm/lib/autocount-line-keys.by-construction.test.ts`: RED on the
unfixed tree (3 failed — `expected 'No line identity was stored: item cod…' to be
null`, `expected 'No line identity was stored: line 1 i…' to be null`), green
after, with a code-mismatch control and a conversion control still refused.

**Also checked — the claim in 0888 that approvals never declare added lines.**
PROVEN from the routes (`enqueueEdit` in `approveSoCommandHandler` and
`approvePoAmendmentHandler` passes neither `newLineIds` nor `retire`) and on
production (run 34828400987): HC-SO-010850/A1 added `DISPOSE BEDDING SET` and its
edit was refused `1 of 8 line(s) carry no AutoCount DtlKey — line(s) 8 (DISPOSE
BEDDING SET)`, then sent by a manual re-queue. 1 ADD / 0 REMOVE since go-live
(section 8). Not fixed here.

**Not fixed here — the documents already in the book** still need their keys
read from AutoCount; see the PR's repair plan.

**Ref.** fix/ac-refused-amendment-docs, 2026-09-14.
