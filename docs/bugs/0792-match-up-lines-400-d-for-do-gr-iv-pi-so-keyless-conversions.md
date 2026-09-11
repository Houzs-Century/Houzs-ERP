## Match up lines 400'd for DO/GR/IV/PI, so keyless conversions could never be matched [high]

**Symptom.** A keyless delivery order / goods receipt (e.g. `HC-GRN-2609-008` and
several DOs) sat on the AutoCount Sync "Not accepted" list with "The ERP cannot
tell which lines AutoCount already has", and pressing "Match up lines" returned
`docType must be one of SO, PO`. There was no way to get them into the book;
staff hit this every day as new conversions are saved.

**Root cause (traced).** The relink route's `DOC` map held only SO and PO —
`backend/src/scm/routes/autocount-relink.ts:42-52` — and returned 400 for any
other type. Nothing deeper was blocking it: the matcher `planLineRelink`
(`scm/lib/autocount-relink-lines.ts`) is document-type agnostic (it pairs book
lines to ERP lines by item code + Desc2), and the host `/doc-read` already serves
all six types (`backend/scripts/autocount-service/AcSyncService.cs` `DocTypes = {
"SO","PO","DO","GR","IV","PI" }`). Only the header/line wiring for the four
conversion documents was absent.

**Fix.** Added DO/GR/IV/PI to the `DOC` map. Their header is resolved through the
outbox row's `doc_id` — the header uuid `enqueueConvert` always stores
(`readConvertHeaderFacts(sb, docType, docId)`) — NOT the queue `doc_no`, whose
shape is not uniform (an unnumbered DO carries its header uuid, a GR its business
number; keying on `doc_no` would repeat the `docs/bugs/0601` trap). Lines link by
that same header id; all four line tables carry `item_code` / `description2` /
`linked_ac_dtlkey` (proven in `autocount-convert-lines.ts` DOWNSTREAM `itemCols`,
lines 170/210/261/285). Writes only `linked_ac_dtlkey` — a link, never money or
stock — and refuses every ambiguous line rather than guessing, same as SO/PO.

Pinned by `src/scm/routes/autocountRelinkRoute.test.ts`: a keyless DO line is
matched and stamped, an ambiguous line is refused and stays keyless, and a
conversion with no queued `doc_id` 404s. Proved RED against the unfixed map (the
DO request 400'd before the entries existed).

**Ref.** `feat/ac-durable-relink-keyed-requeue`, 2026-09-10. Fix B
(rebuild-refused -> keyed edit) remains deferred; see
`docs/ac-durable-sync-fixes-plan.md`.
