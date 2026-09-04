## A document whose lines cannot be matched could never be sent at all [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** HC-SO-013394 has sat HELD BACK since 2026-08-31 — *"The ERP cannot
tell which lines AutoCount already has"*. Pressing **Match up lines** (once its
own crash was fixed, `docs/bugs/0602`) reaches the book and then refuses:

> Nothing could be matched — the document is unchanged.
> `'JM-CL JAC WP MP (Q)'` — 2 unclaimed lines in the account book carry that item
> code and this line has no description to tell them apart.

Correct, and a dead end. Two book lines are indistinguishable, so no matcher can
ever choose between them, and the document could not be sent by any route.

**Root cause (traced).** Not the matcher — the assumption underneath it. Every
path to AutoCount required MATCHING the ERP's lines to the book's, because
`composeEdit` and `AcSyncService.Edit()` both refuse a keyless line: appending
one would duplicate it, and on a purchase order a duplicate can never be
removed. That refusal is right, and it made a document nobody could match
permanently unsendable.

**The owner saw past it.** Told the connector the ERP replaces really deletes and
adds lines:

> 「如果做得到 inistate 的东西，那就是我删或者 addline 都可以 sync 进去，就代表这张
> 单也进得去了啊」

He is right. **The refusal protects against APPENDING. A rebuild appends to
nothing** — the details are cleared and the ERP's list is laid down in order, so
the matching problem does not arise and neither does the duplicate.

I had argued against it on the grounds that it destroys DtlKeys and that
AutoCount's own troubleshooting warns of a grey, uneditable document. That
warning is about a **TRANSFERRED** document, and `scm/lib/downstream-lock.ts`
already refuses to edit one. **My objection was over-broad for the case in
front of us**, and the record should say so.

**Fix.**

* `ComposeOptions.rebuild` — OFF unless the caller asks. Inferring it from a
  failure would turn every future mismatch into a silent teardown of a live
  document, so the escape sits ABOVE the `KeylessLineError` and only fires when
  asked; without it the refusal still throws.
* `AcSyncService.Edit()` honours `Rebuild:true` by calling `doc.ClearDetails()`
  before the line loop, then adding every line in payload order — which is the
  ERP's own order, because `inAcLineOrder` sorts every payload read
  (`docs/bugs/0605`).
* **The host, not the ERP, decides whether the book can survive it.**
  `AnyLineTransferred` reads `ISNULL(d.TransferedQty,0) > 0` from the book's own
  `SODTL`/`PODTL`/`DODTL`/`GRDTL`, because a person can transfer inside
  AutoCount without telling the ERP. `> 0` and not `IS NOT NULL`: AutoCount
  writes 0 on a line that never moved, and a NULL test would call every document
  transferred, making the rebuild unreachable. An unknown document type returns
  `true` — refuse, never rebuild blind.
* `ClearDetails` is on the base document class, so this works for the three
  types the SDK gives no `DeleteDetail`. **It is the only way a purchase order
  can lose a line at all.**

**A bug in this change, found by reading and not by a test.** On a rebuild, a
line the ERP DELETED must be skipped — the cleared document already lacks it.
The skip was first written inside the retire branch, which sits BELOW
`AddDetail()` in the loop: every deleted line would have been added back as a
blank row. Moved above it. **There is no C# toolchain in this environment**, so
nothing would have caught it; `backend/tests/acRebuildDetails.test.ts` asserts
the ordering now.

**Verified.** `acRebuildDetails.test.ts` — 11 tests: the flag is explicit, the
refusal survives without it, the transferred check reads the BOOK, an unknown
type refuses, the clear precedes the loop, the skip precedes `AddDetail`, and a
rebuild never edits a key the clear destroyed. `autocount-writeback.contract.test.ts`
gained `Gone` in its `/edit` line-key list — that file exists so a new key
cannot be added quietly, and it failed until it was declared. Backend typecheck
exit 0.

**UNCOMPILED AND UNDEPLOYED, and nothing has been rebuilt in the book.**
`build-local.ps1` compiles `AcSyncService.cs` on any machine with AutoCount 2.2
installed; that has not been run. Until the office host is rebuilt, `Rebuild`
and `Gone` are keys no binary reads, and behaviour is exactly as today.

**Ref.** fix/autocount-line-order-is-stable, 2026-09-02.
