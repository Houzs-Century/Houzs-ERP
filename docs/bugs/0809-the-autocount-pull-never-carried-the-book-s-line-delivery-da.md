## The AutoCount pull never carried the book's line delivery date, so every imported date went stale [high]

**Symptom.** An imported sales order or delivery order keeps whatever delivery
date it had on the day it was imported, forever. Staff move a date in AutoCount
when a customer changes their delivery, the ERP never hears, and the two systems
disagree with no signal. Reported as HC12445: the book said 19/09, the ERP said
05/09, and the delivery order cut from that sales order inherited the stale date.

**Root cause (PROVEN).** The sync is ONE-DIRECTIONAL on this field.

- AutoCount keeps a document's delivery date on the LINE —
  `SODTL.DeliveryDate`, `DODTL.DeliveryDate`. Read against the live book
  2026-09-11: `SO` and `DO` have no header delivery date and no UDF holding one,
  and `EstimatedDeliveryDate` is NULL on all 49,049 DO lines.
- The read middleware the ERP pulls through serves a NINE-COLUMN HEADER
  projection (`/DeliveryOrder/getSince`, `backend/src/types.ts`
  `ACDeliveryOrder`), and the full `getAll` dump is header rows too. So nothing
  inbound has ever carried the column.
- The write-back DOES push ours to it: `scm/lib/autocount-outbox.ts` maps
  `line_delivery_date` onto `SODTL.DeliveryDate`.

The middleware's source is not in this repository
(`docs/autocount-read-relay-exposure-coe.md`), so the inbound projection cannot
be changed here. What IS here is the write-back service the office host runs,
which already serves four read-only routes nothing inbound uses.

**Fix.** Add the column to the service this repo owns, and pull it on the cron.

- `backend/scripts/autocount-service/AcSyncService.cs` gains `/delivery-dates`:
  one SELECT per document type, returning `DocNo`, `DtlKey`, `DeliveryDate`,
  `DocDate`, windowed on the delivery date itself (`SinceDeliveryDate`, required)
  and capped at 20,000 rows. Read-only, no SDK session, table names from an
  allow-list. `build-local.ps1` prints `COMPILES CLEAN - 116736 bytes`.
- `backend/src/scm/lib/autocount-delivery-date-sweep.ts` pulls it on the
  existing 5-minute cron, keyed by `linked_ac_dtlkey` — never by item code,
  which cannot pair a sofa (the book keeps one line where the ERP keeps one per
  compartment). The decision is a pure function, `planDeliveryDateSweep`, with
  14 cases pinned in `autocount-delivery-date-sweep.test.ts`.
- Switch `scm.app_config 'scm.autocount_delivery_date_sweep'` (off / plan /
  apply), set by the **Set AutoCount delivery-date sweep** workflow. Fails CLOSED
  to `off`.

**It ships with no effect, twice over.** The switch is absent, and the host route
does not exist until `deploy-on-host.ps1` swaps the rebuilt service — a 404 the
sweep reports as `hostRouteMissing` rather than raising.

**What it will not touch, each for a stated reason.** A line whose
`line_delivery_date_overridden` is true (an operator typed that on purpose,
docs/bugs/0807-do-line-delivery-date-silently-dropped-by-payload-key-mismat.md);
a BLANK date, line or header, because a blank is not a CHANGE and filling blanks
moves what MRP waits for on thousands of orders; a header carrying
`amended_delivery_date`, because that disagreement is the write-back's fault, not
the pull's; and the header of a document whose book lines disagree among
themselves, where only the lines move.

**The catch-up for what has already drifted is separate** —
`backend/scripts/repair-delivery-dates-from-book.mjs`, which reads a committed
export of the same column because a CI runner is not on the AutoCount network.
docs/bugs/0810-the-erp-s-delivery-dates-went-stale-because-the-autocount-pu.md.

**Ref.** `feat/ac-pull-line-delivery-date`, 2026-09-11.
