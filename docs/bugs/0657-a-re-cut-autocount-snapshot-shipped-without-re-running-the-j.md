## A re-cut AutoCount snapshot shipped without re-running the jobs that write it, and the reconcile called it a 44-document gap [high]

<!-- area: Cutover + migrated data -->

**Symptom.** On go-live morning, 2026-09-07, `ac-erp-reconcile.yml` (run
34098638553) reported **32 in-scope goods receipts and 12 in-scope delivery
orders absent from the ERP**, both under the heading GAP. Read as written, that
is 44 documents this repo has no importer for, and the next move is to write two
importers.

**Root cause (traced).** All 44 were already in the tree. PR #3029 re-cut the
migration sources from the live book that morning —
`backend/scripts/data/ac-gr-refs.json.gz` and `ac-partial-dos.json.gz` are both
at commit `b31971a9b`, dated 2026-09-07. The two jobs that read them last ran on
**2026-08-29**: `gh run list --workflow=stamp-ac-grn-refs.yml` and
`--workflow=create-migrated-documents.yml` both top out at 33270393516 /
33270435018, nine days earlier. Measured against the committed files, the
in-scope population is carried in full — GR 212 of 212, DO 83 of 83 — so nothing
was missing from the migration source at all.

Both dry runs then said the same thing from the other side.
`stamp-ac-grn-refs.yml` apply=0 (run 34099009512): **54 POs to stamp**, and only
ONE AutoCount PO with a receipt not imported. `create-migrated-documents.yml`
kind=both apply=0 (run 34099013463): GRN **0 to create** (319 of 319 already
mirrored), DO **10 to create**, the remaining 2 blocked on an item code the
mapping CSV cannot resolve to an ERP line.

The reconcile is not wrong — the ERP genuinely does not hold those documents.
What it cannot say, because it only ever compares the BOOK against the ERP, is
whether the remedy is code or a dispatch. Nothing answered that, so a gap of this
shape reads as an importer-sized problem every time.

**Fix.** `backend/scripts/check-ac-gap-attribution.mjs` asks the cheaper question
first and asks it OFFLINE — no database, no network, zero dependencies: for each
type, how many in-scope documents are already carried by a committed migration
source, and which workflow writes them in. It refuses rather than reporting zero
when a source file is absent, because an empty set would make every document look
missing, and "the gap is real" is the wrong answer to reach by accident.

The in-scope definition it uses is the reconcile's own: both now import
`backend/scripts/lib/ac-scope.mjs`, which is the ONE place the population is
written down on this side of the wire (`export-ac-reimport.py` holds the SQL
twin, named line by line in that module's header). It used to be stated twice,
which is how a checker comes to measure a population no importer ever carried.

Proved against the same data the reconcile ran on: `SO 2777/2783, PO 484/484,
GR 212/212, DO 83/83 already carried by a committed source`. The 6 SO are
genuinely newer than the last export, and are the only documents in the whole set
that a re-export would have to fetch before anything could write them in.

Two follow-ons the same trace surfaced, both now in the runbooks rather than in
anyone's memory: `repair-migrated-do-prices.yml` had **never been dispatched**
since it landed on 2026-09-02, which is why 55 of the 71 migrated delivery orders
still read RM 0.00 (bug 0617); and phase 1 of `docs/ac-resync-runbook.md` now
says in as many words that landing a re-cut `data/*.gz` on main is not the same
act as writing it into the ERP.

**Ref.** feat/ac-doc-tally, 2026-09-07. Reconcile run 34098638553; dry runs
34099009512, 34099013463, 34099017739.
