## BUG CLASS - writeback-reads-the-empty-column: the ERP holds it here, the sync reads there [high]

**The shape** — a fact the ERP holds in TWO columns. The UI reads both, so the
screen is right. The AutoCount write-back reads ONE, and it is the empty one.
Nothing on the AutoCount side opens the master, so it surfaces as a foreign key
error at send time — or not at all.

**Why it hides** — the failure is invisible from inside either system. The ERP
row is correct, the screen is correct, the account book simply never receives the
field. Three instances were each found only when a live document failed:
`FK_SODTL_Location` (2026-08-11, header `sales_location` vs per-line
`warehouse_id`), the sofa `supplier_sku` (2026-08-13, "what the supplier calls
it" borrowed as "what AutoCount calls it"), and `FK_SO_SalesAgent` (2026-08-13,
`agent` vs `salesperson_id`). Full incident:
`docs/autocount-writeback-golive-coe.md`.

**Three ways it lands**, decided by the C# and not by the ERP — `Str()` turns a
present-but-null key into `""`:
1. **FATAL-FK** — assigned unconditionally, `""` is not a row in the master
   table, `Save()` throws and the WHOLE document is lost.
2. **SILENT-DROP** — `udf()` drops the null and the UDF is never written. No
   error, no outbox row, no log line.
3. **SILENT-BLANK** — on `/edit` a present-null key OVERWRITES what the account
   book holds.
`Set()` swallows the assignment exception, not `Save()`'s, so wrapping a field in
it buys nothing here.

**The remedy** — do not read a column without asking what writes it. Where two
columns hold one fact, read the same fallback chain the UI reads, and let
`/ensure-masters` open what the book lacks instead of sending a null. The
underlying multiplier is `mapOrPassthrough` returning `null` for an unknown
value: measured against the live book, every target its four maps can emit is
already a real master there and every value they DROP is one the book already
holds — 37 of 37 agent names, 84 of 93 venues.

**Where the class was swept** (2026-08-14, every field on every operation) —
`docs/autocount-field-alignment-audit.md`: 8 more BROKEN fields and 6 AT RISK,
each with the chain (ERP column -> composer -> master opened? -> C# assignment ->
failure mode) and a fix. **Not fixed by that PR** — it changed no source; each
finding gets its entry here when its fix ships. The ERP-side counts come from
`backend/scripts/check-autocount-field-alignment.mjs` +
`.github/workflows/autocount-field-alignment.yml` (read-only, `workflow_dispatch`).

**Ref** — PR #2149, 2026-08-14. Instances already fixed: #2093 / #2095 / #2119
(supplier_sku), #2112 (location), the `salesperson_id` fix in flight.
