## The ERP's delivery dates went stale because the AutoCount pull never carried the book's line delivery date [high]

**Symptom.** Owner 2026-09-11, item 6 of a floor report: *"Syu - HC12445. Pick DO
at autocount before implement of ERP. Delivery date is 19/09. Pick DO on 05/09.
now the ERP write down DO date 19/09 and cus delivery date 05/09."* A delivery
order imported from AutoCount showed a delivery date of 05/09 while the book
said 19/09 — so the ERP and the account book disagreed about when a customer's
furniture was going out.

**Root cause (PROVEN, three reads against live systems).**

1. **The live book, read read-only over ZeroTier** (`export-ac-delivery-dates.py`
   against `AED_HOUZS`): `SO-011302` carries `SODTL.DeliveryDate = 2026-09-19` on
   all three lines, and `DO-011559` carries `DocDate = 2026-09-19` with
   `DODTL.DeliveryDate = 2026-09-19` on all three.
2. **The live ERP** (`scm.delivery_orders`, `scm.mfg_sales_orders`):
   `HC-DO-011559` held `do_date = 2026-09-19` (correct),
   `expected_delivery_at = customer_delivery_date = 2026-09-05` (wrong), and
   `HC-SO-011302` held `customer_delivery_date = 2026-09-05` (wrong). Its three
   DO lines held `line_delivery_date = NULL`.
3. **The committed 2026-08-11 snapshot** (`data/ac-fidelity-so-lines.json.gz`),
   which is what the import read: `SO-011302`'s lines carried
   `DeliveryDate = 2026-09-05`.

So the import was RIGHT when it ran. The customer moved the date, a staff member
changed it in AutoCount, and **nothing in the ERP ever reads that column again**:
the middleware's `/DeliveryOrder/getSince/{checkpoint}` is a nine-column HEADER
projection (`src/types.ts` `ACDeliveryOrder`) and the delivery date lives on the
LINE. The other direction works — `scm/lib/autocount-outbox.ts` maps
`line_delivery_date` to `SODTL.DeliveryDate` — so the sync is one-directional on
this field, which is drift by construction. The DO cut from that sales order then
inherited the stale 05/09 through the SO -> DO carry.

**Scale, measured 2026-09-11 (company 1, AutoCount-linked):** of 2,939 sales
orders, 600 agree with the book, **100 differ**, 39 are blank in the ERP and
2,205 have book lines that disagree among themselves (so no single header date
exists). Of 237 delivery orders, **81 differ**; only 7 have a `do_date` that
differs from the book's `DocDate`, so the DOCUMENT date is fine and it is the
DELIVERY date that drifted. 510 sales-order lines and 850 delivery-order lines
also differ, the DO lines because every one of them is blank (bug 0807-do-line-delivery-date).

**What was WRONG with the first fix, and how it was caught.** PR #3615
(`repair-do-delivery-dates-to-autocount.mjs` [gone]) set a linked DO's delivery
dates to its own `do_date`, on the premise that AutoCount's line delivery date
equals its document date. Measured on the same live book: for our 235 linked
delivery orders the two are equal on 170 and **differ on 65 (28%)**. Applying it
would have stamped a wrong delivery date on 65 live documents. It read correct on
`HC-DO-011559` only because that one document happens to have both dates equal.
The premise was recorded as a "known caveat" rather than measured; measuring it
took one query.

**Fix.**

- `backend/scripts/export-ac-delivery-dates.py` (new) exports the book's real
  `SODTL/DODTL.DeliveryDate` — per document and per `DtlKey` — to
  `backend/scripts/data/ac-delivery-dates.json.gz`. Read-only, READ UNCOMMITTED
  so a wide read cannot starve the outbound write-back.
- `backend/scripts/repair-delivery-dates-from-book.mjs` (new) +
  `.github/workflows/repair-delivery-dates-from-book.yml` set the ERP's
  header and line delivery dates from that column, keyed by `linked_ac_dtlkey`
  (never by item code — the book keeps a sofa as ONE line where the ERP keeps one
  per compartment). PLAN by default, `CONFIRM=DELIV-DATES-FROM-BOOK` to apply,
  fresh-connection shape verification.
- `DO_SALES_CARRY` (`scripts/lib/customer-block.mjs`) and the hardcoded mirror of
  the same UPDATE in `scripts/lib/migrated-do-writer.mjs` no longer set a
  delivery date at all. Both values they could reach for are measured wrong; the
  backfill cannot know the book's, so it no longer guesses. Pinned by
  `backend/tests/migratedDoSalesFields.test.mjs`, which now asserts the ABSENCE
  of both columns and that no expression mentions `do_date`.
- `repair-do-delivery-dates-to-autocount.mjs` [gone] and
  `repair-do-delivery-dates.yml` [gone] are deleted, so the 28%-wrong repair
  cannot be dispatched by someone reading the old handoff.

**What is NOT fixed, and needs the office host.** The pull still does not carry
the field, so the drift returns. The durable fix is a middleware change on the
AutoCount host (`scripts/autocount-service/`, deployed by `deploy-on-host.ps1`)
to add the line delivery date to the SO/DO projections, plus an ERP-side ingest
that updates existing rows. Until then this repair is a STOPGAP and is labelled
one in its own header.

**Ref.** `fix/ac-delivery-date-from-book`, 2026-09-11. Supersedes the repair half
of docs/bugs/0804; the stale-SO source it replaced is docs/bugs/0716 / 0723.
