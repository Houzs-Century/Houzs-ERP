## Four refusal classes the AutoCount Sync page could not name, and one needle that matched nothing [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Found while enumerating every reason a row can end up `failed` or
`skipped` for `docs/autocount-sync-reasons.md` — the catalogue the page's new
Send-again button reads its sentences from. `AC_SKIP_KINDS` is what turns a
`skipped` row's raw text into a `reason_kind` and a REMEDY, and for a large
group of live refusals it produced `unrecognised` with a **null remedy**: the
page names the problem and offers no next step, on rows whose next step is one
field on one form.

**Root cause (traced, by reading every writer of a `skipped` reason rather than
the table).** Three separate holes, and they have the same shape — a needle
written from something other than the writer.

1. **Three refusal classes had no needle at all.** `noteReadFailure`
   (`backend/src/scm/lib/autocount-outbox.ts`) writes
   `refused, nothing sent (${e.name})` for **eight** error classes;
   `AC_SKIP_KINDS` carried five of them. Missing: `MissingAgentError`,
   `MissingSalesLocationError`, `MissingCreditorError`. The first is not
   hypothetical — it is the class written for exactly the failure the live book
   answered on go-live day, 2026-08-13, `FK_SO_SalesAgent` on HC-SO-2608-001 and
   -002.

2. **`no-autocount-shape`'s needle matched nothing any code path writes.** It
   was `'AutoCount has no shape'`, which is a phrase from
   `recordConvertSkipped`'s own DOC COMMENT. The five call sites that record a
   merged conversion — `delivery-orders-mfg.ts`, `grns.ts` (twice),
   `sales-invoices.ts`, `purchase-invoices.ts` — all write
   `"AutoCount transfers from ONE source document"`. So every merged conversion
   in the queue has classified as `unrecognised` since the feature shipped.

3. **Four more reasons were never in the table**: the DtlKey-subset refusal
   (`readConvertSourceKeys`), `cancelled in the ERP before it was written to
   AutoCount` (`enqueueCancel`), `edited before its AutoCount counterpart
   existed` (`enqueueEdit`), and the mislinked-GRN refusal (`grnLinkIsReallyAPo`).

This is the same failure as #2094 one turn of the screw further on. That one
matched the shared PREFIX and so gave three classes the fourth's remedy; this
one matched a comment, and a phrase nobody writes, and so gave several classes
no remedy at all. Both come from taking the needle from near the writer instead
of from the writer.

**Fix.** Eight entries added or corrected in `AC_SKIP_KINDS`
(`backend/src/scm/lib/autocount-outbox-status.ts`) and in its plain-node mirror
`backend/scripts/lib/autocount-skip-kinds.mjs`, which
`autocountOutboxStatus.canonical.test.ts` refereed as usual. Every one of the
needles was taken from the string the writer actually produces, quoted in the
same PR into `docs/autocount-sync-reasons.md` beside its trigger, whether a
re-send can fix it, and what a person should do.

**Not fixed, recorded instead** (`docs/autocount-sync-reasons.md` §5): these
needles are still strings typed twice with nothing checking them against the
writers, which is exactly how hole 2 survived from the day it shipped. A
generated check over the reason-producing call sites is the thing that closes
the class; a bigger table is not. Also recorded there: `masters-not-opened` can
never classify, because the route only classifies rows whose status is
`skipped` and the drain writes that message onto a `failed` row.

**Ref:** this PR, 2026-08-16.
