## The Processing Date has surfaces that read it by NAME, and every one of them fails in silence [high]

**Symptom (latent, not yet fired)** - the owner, 2026-08-13, after saying it more
than three times: *"你确保你的 process 里,把 internal expected date、processing
date 和 process date 都直接整合变成一个,不要再搞多个了。因为每一次讨论到
processing date 的时候,你就有各种各样的 bug,原因就是因为你有太多个了。"* The DATA
was unified the same day (#2077 / #2079 moved 519 company-1 orders out of
`proceeded_at`; both companies now report zero split). What was left was the
naming - and a rename is only safe once the surfaces that read this date through
a STRING have been found, because those do not break loudly. Measured on
`origin/main` at 8b4853fa: 344 occurrences of `internal_expected_dd` /
`internalExpectedDd` across 73 files, 211 of `proceeded_at` / `proceededAt`
across 48. (The 269/161 in the brief was an undercount.)

**Root cause** - three separate mechanisms, one failure shape.

1. **The 2990 mirror drops what it does not recognise.** `lib/mirror-map.applyMap`
   is `for (const [k, v] of Object.entries(row)) if (m.destCols.has(k)) out[k] = ...`
   - destCols comes from the destination table's `information_schema`. An
   unknown key is not copied and nothing is raised. 2990 is a SEPARATE
   REPOSITORY on its own deploy schedule, and its pg_cron drainer can still be
   carrying rows queued before either deploy, so after a Houzs rename the old
   column keeps arriving, gets dropped, `/api/sync/so-mirror` returns 200, and
   the Processing Date stops appearing on every company-2 SO. The board, the
   edit lock, MRP and the AutoCount PDate push all read it.

2. **A stored payload keeps the key it was written with.** `scm.so_amendments.header_changes`
   is a jsonb authored at REQUEST time and read at APPROVE time, days later and
   across any number of deploys. `lib/so-revision.applySoAmendment` walks it and
   `continue`s on any key absent from the amendable allow-list; `routes/so-amendments.ts`
   gates the date-pair re-check AND the deposit gate on the same string literal.
   After a payload-key rename a pending amendment approves cleanly, audits
   cleanly, skips both gates and writes nothing at all. This is the worst of the
   three: a Processing Date that was requested, reviewed and signed off, and then
   silently did not happen.

3. **A name meaning three things.** `routes/delivery-planning.ts` stuffed a job
   leg date into a field literally called `internal_expected_dd` on the board's
   SYNTHETIC rows - ASSR service legs, manual DP jobs, PMS project windows. Those
   are not sales orders: no deposit gate, no supplier PO, no edit lock, so they
   have no processing date at all. That is a THIRD meaning of the name on rows
   that cannot have one, sitting in the same union as the real thing.

**What was NOT the problem, checked rather than assumed.** A queued AutoCount
outbox payload is composed in AUTOCOUNT vocabulary - `payload.body` is the
AcSyncService document (`DebtorName`, `DocDate`, `UDF.{BRANDING,VENUE,ToPONo,PDate}`,
`Details[]`), and the only ERP identifiers that survive into it are
`writeback` / `lineWriteback` / `fromDoc` / `selfDoc`, which name a table and
`doc_no` or `id`. No ERP column name for a business field is frozen in a queued
row, so an ERP rename cannot strand one and no payload migration is needed.
`mastersOf` reads the UDF block for `BRANDING` and `VENUE` only; `PDate` is a
date, not a dropdown master. The COMPOSE side is what breaks, and silently -
`SO_HEADER_COLS` is a string select list, `soEditHeader` reads a bare `Record`,
and `composeCreateSo` is handed `header as never`.

**Fix** - `backend/src/scm/shared/so-processing-date.ts` is now the ONE place the
name lives (it is not a fourth name: it invents no word, it exports the column
and payload key that already exist). Bound to it: the outbox select list (one
template literal + `as const` - supabase-js parses the select at the type level
and string concatenation with `+` widens to `string`, which comes back as
`GenericStringError`),
`soEditHeader`'s untyped read, and `AcSoHeader`'s field via a computed property
key. `mirror-map` gains `aliasCols`, applied ONLY when the old name is gone from
the dest table and the new one is present - so it is a proven no-op before a
rename and the fix the day of one, which is what makes registering it early
safe. `canonicaliseSoHeaderChanges` rewrites legacy stored keys onto today's on
both `header_changes` read sites. The delivery board's synthetic rows now send
`internal_expected_dd: null` and carry their leg date as `job_date`.

**Blast radius of the board change, checked before making it.** Nothing on the
board reads `internal_expected_dd` for a synthetic row: the "Internal Est."
column was removed in the owner's 2026-08-04 column pass, the HC fields drawer
(whose `procLockActive` reads it, and which would otherwise have called a
past-dated service leg "processing locked") is offered on `so` rows only -
`DeliveryPlanning.tsx` routes project / dp / assr rows to different menus - and
the mobile run-sheet's `effDateOf` reaches `effective_delivery_date` first, which
every synthetic row sets to the same leg date. So the field was write-only on
those rows and nulling it is behaviour-identical.

**Left loud on purpose.** `tests/scaleRouteDrift.test.mjs` `deepEqual`s a
hard-coded column list against the route's `HEADER` expression - it is the
tripwire and it is meant to fail; note it appends `, proceeded_at,
paid_total_centi, balance_centi_live` as its own literal, so retiring
`proceeded_at` needs an edit there too. `amendment-lane.classifyHeaderKey`
THROWS on an unknown key (submit-time only). `frontend/src/vendor/scm/lib/so-field-policy.test.ts`
parses the backend policy table by REGEX ON QUOTED LITERALS, so a renamer must
NOT replace those rows with a constant - the row would vanish from the parse.
`mfg-sales-orders`'s `SORT_COLS` silently falls back to `so_date` on an unknown
sort key, but the Processing Date is not in that set today.

**Still unbound, and named so the next person does not have to find them again.**
`so_internal_expected_dd` is a DERIVED response field stamped by
`routes/sales-invoices.ts` and `routes/delivery-orders-mfg.ts` and read as a
string by four frontends, including `MobileModuleList`'s
`pick(r, "soInternalExpectedDd", "so_internal_expected_dd")` - rename one end
only and a "Processing" column blanks with no error.
`SalesOrderDetailListing.tsx` reads `opt(r, 'internal_expected_dd')` off the
flattened header. The grid `key: 'processing_date'` in three lists is a SAVED
LAYOUT key persisted per user (migration 142) - it is already the unified name
and must not move.
