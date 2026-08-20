## Every UDF went into AutoCount as a STRING, so the one DATE UDF never landed [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner 2026-08-16: editing a sales order's Processing Date does not
reach AutoCount. `HC-SO-2608-002` holds `processing_date = 2026-08-16` in the
ERP; the live book still shows `UDF_PDate = 8/13/2026`.

**Root cause (traced).** `ApplyUdf` stringified every value —
`kv.Value.ToString()` — and wrote it through `Set()`, which catches, logs
`set skipped: <message>` with no key, no value and no route, and lets the request
answer `{"ok":true}`. So the outbox row goes to `sent` and nothing anywhere says
a field was dropped. `PDate` is the only DATE-typed UDF column the ERP sends:
`export-ac-fidelity-truth.py:106-107` reads `UDF_VENUE` / `UDF_BRANDING` through
`LTRIM(RTRIM(...))`, `UDF_BALANCE` through `ISNULL(...,0)` and `UDF_PDate`
through `CONVERT(varchar(10), ..., 120)`, and one exported value carries a time
(`SO-010311 = "2026-07-22 01:00:00"`).

**What the evidence RULED OUT.** "Create works, edit does not" was the starting
theory and production refuted it (read-only run 31943942030,
`why-so-line-not-purchasable.mjs` against the prod outbox):

- `HC-SO-2608-002`'s **create sent no `PDate` at all** — `UDF = {VENUE, ToPONo,
  BRANDING}` — yet the book holds `UDF_PDate` = that document's own `DocDate`.
  Nothing the ERP sent put it there. `HC-SO-2608-003` looks "correct" only
  because its processing date and its `DocDate` are the same day, so it cannot
  tell the two apart. **The create path has never been shown to write a PDate.**
- The edit path is NOT the problem either: `BALANCE` and `PAYEMENT` were absent
  from that document's create payload and present in the book, so they can only
  have arrived on an edit. The loss is **per key**, not per path.
- `UDF_PDate` is not merely a copy of `DocDate` in general — of the 13,015
  headers in `ac-fidelity-so-headers.json.gz`, 5,234 differ from `DocDate` and
  2,643 are blank.

**Fix.** `ApplyUdf` tries the STRING first and unchanged — every key that lands
today lands the same way — and only after the book refuses it does it retry with
a typed value: `null`/`DBNull` for the present-and-null blank (#2218's
asymmetry is preserved; an absent key is still never touched), `Decimal` for a
numeric string, `DateTime` for a date. Each attempt is per key, and a key that
lands on no rung is logged BY NAME with every refusal, instead of one anonymous
`set skipped:`. `Set()` itself is untouched and still guards ~30 other
assignments. The contract test's expectation moved with it.

**Not verified here, and it is the reason for the ladder:** C# cannot be
compiled in this environment, the `UDF` member is INHERITED so
`sdk-api-reference.txt` (dumped `DeclaredOnly`) does not record the indexer's
parameter type, and the exact exception has never been read off the host log.
The string attempt stays first so the worst case is today's behaviour;
`deploy-on-host.ps1` compiles before it swaps and keeps the previous exe.

**Ref.** fix/processing-date-reaches-autocount, 2026-08-16.
