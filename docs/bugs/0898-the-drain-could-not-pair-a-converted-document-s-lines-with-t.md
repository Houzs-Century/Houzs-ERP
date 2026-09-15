## The drain could not pair a converted document's lines with the book, because the host never said which source line each came from [high]

**Symptom.** Every delivery order and goods receipt the write-back creates can
reach AutoCount with no line keys, and then its next edit is refused whole
(`KeylessLineError`). docs/bugs/0897 records the population this left in the
book on 2026-09-14 (82 delivery orders, 64 goods receipts) and the one-off
stamp that fills it; this entry is why new documents kept joining it.

**Root cause (traced).** `AcSyncService.cs` `CreatedLines` answered a
conversion with `DtlKey`, `ItemCode` and `Desc2` per line and nothing naming
the source line, so `persistLineKeys`
(`backend/src/scm/lib/autocount-line-keys.ts`) had to pair by count and item
code. A conversion does not preserve either: AutoCount holds a sofa as one line
where the ERP holds one row per piece ("AutoCount reported 2 line(s) and the ERP
sent 3"), and it copies the SOURCE line's item code, which for a supplier-coded
product is the book's spelling ("'AK-BASTION MATT (Q)' in AutoCount but 'AKEMI
BASTION MATT (Q)' here"). Refusing was right; the missing input was the
source line. The detail tables do not carry it (`DODTL.FromDocDtlKey` NULL on 0
of 111 lines, `GRDTL` 0 of 51 on the write-back's documents), but `DocTransfer`
does, for every transferred line.

**Fix.**

- Host: `CreatedLines` adds `FromDocDtlKey`, read from `DocTransfer` for the
  line's own document type, sent only when exactly one transfer row names the
  line. `build-local.ps1`: `COMPILES CLEAN - 117248 bytes`. **Not deployed** —
  the office host has to be rebuilt (`deploy-on-host.ps1`) before any document
  carries the field.
- ERP: `parseCreatedLines` (moved to
  `backend/src/services/autocount-created-lines.ts`, out of the capped
  `autocount-writeback.ts`) keeps a positive-integer `FromDocDtlKey`.
  `persistLineKeys`, for `so_to_do`, `po_to_gr`, `do_to_iv` and `gr_to_pi`, pairs
  by that link when every line carries it: our row's source pointer
  (`DOWNSTREAM[type].sourceFk`) -> that row's `linked_ac_dtlkey` -> the book line
  it fed, using `backend/scripts/lib/conversion-line-key-plan.mjs`, the rule the
  0897 stamp runs. A row it cannot prove keeps NULL and is named in the outbox
  row's reason. Without the field (today's host) nothing changes.
- Tests: `backend/src/scm/lib/autocount-line-keys.transfer-link.test.ts` — the
  HC-DO-2609-096 shape (sofa as one book line, book spellings) pairs exactly; a
  receipt line with no source is named; one source on two lines is refused; an
  old host and a create take the old path; the parser keeps only a positive
  integer. Proved RED with `autocount-line-keys.ts` reverted: 3 failed.

**Ref.** fix/ac-conversion-keys-at-drain, 2026-09-14.
