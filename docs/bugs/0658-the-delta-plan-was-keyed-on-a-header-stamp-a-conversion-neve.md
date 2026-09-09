## The delta plan was keyed on a header stamp a conversion never moves [high]

**Symptom.** Owner, go-live morning 2026-09-07: the sales orders and purchase
orders we migrated have moved on in AutoCount — some are delivered, some are
received, some have had a PO raised from them — "你需要查看一下之前搬进来的这些
数据，因为现在可能已经发生了变化". `sync-ac-delta.mjs` was the tool for exactly
that question and it reported nothing about any of it.

**Root cause (traced).** `sync-ac-delta.mjs` builds its whole update plan from
`ac-doc-stamps.json.gz` — `const editedSo = (S.stamps.SO || []).filter(...)`,
and every lane below it (description2, sofa compartments, payment/balance)
iterates that list. `S.stamps` is one row per document whose HEADER `Modified`
moved since the cut. A conversion does not move the parent header: it creates a
CHILD document and increments the parent LINE's `TransferedQty`. Measured on the
committed 2026-09-07 stamps cut (`since=2026-08-29`):

- of the 115 purchase orders a goods receipt was raised from, **110 do not
  appear in `stamps.PO` at all**;
- of the 166 sales orders a delivery was raised from, **60 do not appear in
  `stamps.SO`**;
- of the 84 sales orders a purchase order was raised from, 11 do not.

Section 4 of the same script does read the CHILD edges, so the conversions were
counted — but it only ever asks whether the *source* document is in the ERP
(`inErp(t, n)`), never whether the ERP reflects the child, and it compares no
quantity. So a purchase order the book had fully received could sit in the ERP
at `received_qty = 0` and every tool in the repo called it fine. Measured
against production the same morning: **231 PO lines on 109 purchase orders**
where the ERP's `received_qty` is short of AutoCount's `TransferedQty`, and
**101 sales orders delivered in the book since we took our copy** with no
delivery in the ERP.

**Fix.** A fifth, report-only section in the same script, keyed on
`TransferedQty` out of the committed `ac-reconcile-truth.json.gz` (all six
types, every header and line, no filtering) and scoped to the population already
migrated: SO→DO, PO→GR, SO→PO and the proceeded lines whose `Desc2` moved since
import. Each case is split by the CHILD document's `DocDate` against the ERP
row's own `created_at`, so a conversion made SINCE the migration is never added
to history the owner decided not to import. It closes by printing how many of
those documents a header-stamp delta could not have seen, so the blind spot
stays a number in the log rather than a claim in a commit. It writes nothing.

Proved on the production plan run
[34101082341](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34101082341)
(before the date split) and
[34101353639](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34101353639)
(after). No `MODE=apply` was run.

**Second defect, found in the first run's own output.** The variant comparison
reported 202 proceeded lines whose build text had "changed". Reading them, 193
differ only by a curly quote where the ERP holds a straight one, or a newline
where the book has a space — the export/gzip/import round trip, not a person
changing a specification. On go-live day that number pointed at the wrong work.
The comparison now normalises quote style and whitespace before deciding, and
reports the two populations separately: **9 real build changes, 193 round trip.**

**Ref.** `feat/ac-conversion-delta-2026-09-07`, 2026-09-07.
