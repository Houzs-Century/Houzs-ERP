## `/create-so` saved a document with a BLANK number and answered ok:true [high]

<!-- area: AutoCount sync + write-back -->

**Found by doing it to the live book, 2026-08-15.** Not a production defect —
proven below — but an unrecoverable one when it fires.

**Symptom.** `POST /create-so` without a `DocNo` answered
`{"ok":true,"docNo":"","lines":[]}` and created a real, uncancelled sales order
in `AED_HOUZS`: `DocKey 906099`, `DocNo` blank, one line `DtlKey 906100`
(`AK-SLEEP ESSENTIAL 7 HOLES`, qty 1, RM1, KL). `lines` came back empty because
the read-back finds lines BY `DocNo`, and there was none to find.

**Root cause (traced).** `AcSyncService.cs` had `so.DocNo = Str(p, "DocNo")`,
and `Str()` answers `""` for an absent key — not null, not an error. AutoCount
accepted the blank and `Save()` succeeded.

**Why it is worse than a failure.** Every route addresses a document BY `DocNo`:
`/edit`, the converts, and `/cancel`. A blank-numbered document therefore cannot
be edited, converted, or even CANCELLED through this service — the owner's
"never delete, only cancel" rule has no instrument. It can only be reached by
hand in the AutoCount UI.

**Production was never exposed, and this is the check rather than the claim.**
On the live book, `SELECT COUNT(*) FROM SO WHERE DocNo IS NULL OR
LTRIM(RTRIM(DocNo)) = ''` returned **1**, and that row is the one just created,
`CreatedTimeStamp 8/15/2026 10:11:29 PM`. The ERP has never done this — it
always sends its own number (module guide 7g) — and `qa-convert.ps1` sends one
too. Only a hand-written payload can reach it.

**Fix.** `RequireDocNo()` on `/create-so` and `/create-po`: refuse, naming the
reason, instead of saving something nobody can address. Nothing in the book
relies on AutoCount auto-numbering for us, so refusing costs nothing.

**Cleared 2026-08-15.** `DocKey 906099` was found in the AutoCount Sales Order
list and **voided, not deleted**. It did not appear until the grid was
REFRESHED - that list is cached, so a document created behind its back is
invisible until then. Worth knowing the next time something is "not in
AutoCount".

**Ref:** this PR, 2026-08-15.
