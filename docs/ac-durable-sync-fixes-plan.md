# AutoCount durable sync fixes — plan

Owner directive 2026-09-10: the keyless / rebuild-refused documents must actually
reach AutoCount ("怎麽样都要进"), not be archived off the list. This is the root
fix so new documents of those classes stop getting stuck.

## Fix A — extend "Match up lines" (relink) to DO / GR / IV / PI

**What it fixes.** A keyless delivery order / goods receipt / invoice cannot be
matched up against the book today, so the operator has no way to clear it. Today
"Match up lines" 400s for anything but SO/PO.

**Proven feasible (not assumed):**
- The host `/doc-read` already accepts all six document types —
  `backend/scripts/autocount-service/AcSyncService.cs:518`
  (`DocTypes = { "SO","PO","DO","GR","IV","PI" }`) and `DocRead()` at `:694-697`.
- The matcher `planLineRelink` (`backend/src/scm/lib/autocount-relink-lines.ts`)
  is document-type agnostic — it takes `bookLines` + `erpLines` and pairs by
  AutoCount item code, separating repeats by Desc2 and refusing the ambiguous.
  Nothing in it is SO/PO specific.
- Only the route's `DOC` map is SO/PO-only —
  `backend/src/scm/routes/autocount-relink.ts:42-52`.

**The four downstream shapes** (from `autocount-convert-lines.ts:160-284`,
`DOWNSTREAM`):

| type | line table | line→header FK | header table | header carries |
| --- | --- | --- | --- | --- |
| DO | `delivery_order_items` | `delivery_order_id` | `delivery_orders` | `id`, `linked_ac_docno` |
| GR | `grn_items` | `grn_id` | `grns` | `id`, `linked_ac_docno` |
| IV | `sales_invoice_items` | `sales_invoice_id` | `sales_invoices` | `id`, `linked_ac_docno` |
| PI | `purchase_invoice_items` | `purchase_invoice_id` | `purchase_invoices` | `id`, `linked_ac_docno` |

All four link their lines by the header's `id` (uuid), like PO's `parentFrom:
'headerId'` — not by a business doc_no like SO.

**The one thing to confirm on production before coding (the docs/bugs/0601
trap).** The relink route finds the header with `.eq(headerKey, docNo)` where
`docNo` is what the UI passed from the outbox row. The outbox `doc_no` is NOT the
same shape for every downstream type — a DO row's `doc_no` was seen as the header
UUID (`8b631d05-…`), a GR row's as the business number (`HC-GRN-2609-008`). Key
the header lookup on the wrong column and it silently stamps the wrong line into
a live book. Confirm each type's real `doc_no` / `doc_id` with a read-only probe,
then set `headerKey` per type accordingly (uuid → `id`; business number →
`do_number` / `grn_number` / `invoice_number`). Prefer resolving via the outbox
row's `doc_id` (the header uuid the enqueue used) so the key shape is uniform.

**Steps (TDD):**
1. Probe the stuck DO/GR rows' actual `doc_no` + `doc_id` (read-only).
2. Add DO/GR/IV/PI entries to the `DOC` map with the confirmed `headerKey`.
3. Test: `planLineRelink` already has SO/PO tests; add a DO-shaped case and a
   route-level test that the DOC map resolves each type's header + lines.
4. Typecheck + tests + PR.
5. After deploy: the UI "Match up lines" works for keyless DO/GR; relink each
   stuck doc, then it composes a keyed edit and lands.

**Risk: LOW.** Writes only `linked_ac_dtlkey` (a link, never money/stock), same
as today's SO/PO relink, and refuses every ambiguous line rather than guessing.

## Fix B — rebuild-refused documents → a keyed edit (DEFERRED, higher risk)

**Why it is not a flag flip.** `editRebuildVerdict`
(`backend/src/scm/lib/autocount-requeue.ts:697-753`) re-sends a skipped edit ONLY
as a REBUILD, on purpose: a skipped edit's payload is `{}`, so the lines the
original save hard-deleted (`retire`) cannot be recovered from the row, and a
keyed edit would leave those deleted lines live in the book (`docs/bugs/0613`).
The host then refuses the rebuild when any line is already transferred
downstream — a genuine AutoCount rule, not our bug: you cannot wipe a line a PO
or GR was raised from.

**What the real fix is.** Recompose the edit from the LIVE document state (what
an ERP save does — it has the full line set INCLUDING what was removed), so the
send is a keyed edit that changes/adds without wiping transferred lines. This
touches the send path that moves money and stock, so it must be built in small,
separately-tested steps with equivalence proven against the composer — not
bundled with Fix A.

**Status:** designed only. Build after Fix A, on its own branch, with the owner
told it is the risky half.
