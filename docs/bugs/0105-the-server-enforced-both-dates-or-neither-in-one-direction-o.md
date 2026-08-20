## The server enforced "both dates or neither" in one direction only [medium]

**Symptom** - the New/Edit SO form refuses a lone date in either direction
(`so-form-validate.ts:94`, `hasP !== hasD`), but a Delivery Date with no
Processing Date could still land on a row. `probe-so-date-xor.mjs` counts them
live, split by direction.

**Root cause** - the shared server gate `collectProcessingGateProblems`
(`so-save-problems.ts`) only ever asked for the DELIVERY half, and only inside
`if (facts.procDate && facts.completeness)` - so a delivery date with no
processing date raised nothing at all, on any path. The SO create and header
PATCH routes each short-circuit on `processing_delivery_must_pair` before
reaching the helper, which hid it; the consignment header PATCH
(`consignment-orders.ts:1296`) and the amendment approver
(`so-amendments.ts:605`) have no such short-circuit and passed a lone delivery
date straight through.

**Fix** - the helper now reports the missing direction as
`processing_delivery_must_pair`, carrying the SAME grandfather the past-date
rules use (`origProcDate` / `origDelivDate`): it fires only when THIS save
changed one of the two dates, so a stored unpaired date an unrelated edit leaves
alone still saves. That matters against live data - a 2026-08-13 backfill paired
117 orders from AutoCount and 19 stayed honestly unpaired because AutoCount has
no delivery date for them either.

**Lesson** - a validation that exists on both the client and the server is only
as strong as its server half, and "the routes already check it" is not the same
as "the shared rule checks it". Two of five callers of this helper had no
short-circuit of their own.

**Ref** - `fix/date-pair-server-side`, 2026-08-13
