## The detail header badge said Posted and Sent where the owner ruled Submitted, and the phone said Loaded one rung early [medium]
<!-- status: fixed -->
<!-- area: Frontend + mobile -->

`fixed` means merged; a frontend change reaches the screen with the deploy that
follows the merge.

**Symptom.** Open a Goods Received, Purchase Invoice or Sales Invoice on the
desktop and the status badge at the top of the page said **Posted** (GRN, PI) or
**Sent** (SI). The owner ruled on 2026-09-12 that this rung reads **Submitted** on
those documents 「PI、SI、GR、PO、SO 都要改成 submitted」, and the list pill for the same
document already did. A Purchase Return's badge said **Posted** where
`status-pill.ts` says **Confirmed**. Found by reading the code while collapsing the
status maps (`docs/bugs/0866-six-status-maps-collapsed-onto-status-pill-and-the-detail-ba.md`);
reported, not observed by staff.

The phone was wrong on the same documents by a different road, and worse on one
of them: a delivery order at `LOADED` read **Loaded**, which is the word the owner
gave the NEXT rung (`DISPATCHED`, 2026-08-26). `DISPATCHED` itself read
**Dispatched**.

**Root cause (traced).** Two more hand-made copies of the status vocabulary.

- Desktop: each of the four detail pages rendered its header `<Badge>` from a flat
  `STAGE_LABEL: Record<string, string>` declared in the page. The 2026-08-21 and
  2026-09-13 sweeps changed the `{ tone, label }` maps and the canonical map; no
  sweep ever opened `STAGE_LABEL`.
- Phone: `frontend/src/mobile/MobileModuleDetail.tsx` `StatusPill` did
  `raw.replace(/_/g, " ").toLowerCase()…` over the STORED value for every document
  module — the same shape the printed documents had before
  `docs/bugs/0548-every-printed-document-title-cased-the-raw-stored-status-ins.md`.

**Why both guards missed it.** `confirmRungReadsSubmitted.test.ts` fails only on a
stored value beside a `"Confirmed"` label, and these said "Posted" and "Sent".
`localStatusMapsAgree.test.ts` parsed only the `{ … label: "X" }` object shape, and
`STAGE_LABEL` is `KEY: "X"` with no object around it. The phone pill had no map at
all, so there was nothing for either to read. A guard that matches one spelling of
a copy does not see the next spelling.

**Fix.**

- The four desktop pages call `statusLabel(docType, status)` for the badge; their
  `STAGE_LABEL` maps are deleted.
- The phone's document header takes a REQUIRED `statusDoc: StatusDocType | null` on
  every module in `DOC_MODULES` (seven SCM documents name their vocabulary; the six
  consignment modules pass `null`, keep humanising the stored value, and so keep
  their own words — the owner kept "Proceed" for consignment on 2026-09-13). Leaving
  it out does not compile: proved by deleting `grns`' line, which failed `tsc -b`
  with TS2741, then restoring it.

**Every word this changes on screen**, measured by evaluating the old and new
label for every status in each document's canonical vocabulary, not by reading:

| surface | status | was | now | authority |
|---|---|---|---|---|
| GRN detail badge | POSTED | Posted | Submitted | owner 2026-09-12 |
| GRN detail badge | CLOSED | CLOSED (raw key) | Closed | status-pill.ts |
| GRN detail badge | ON_HOLD | ON_HOLD (raw key) | On Hold | status-pill.ts |
| PI detail badge | POSTED | Posted | Submitted | owner 2026-09-12 |
| PI detail badge | PARTIALLY_PAID | Partially paid | Partially Paid | status-pill.ts (letter case) |
| PI detail badge | VOID | VOID (raw key) | Void | status-pill.ts |
| PI detail badge | ON_HOLD | ON_HOLD (raw key) | On Hold | status-pill.ts |
| SI detail badge | SENT | Sent | Submitted | owner 2026-09-12 |
| SI detail badge | PARTIALLY_PAID | Partially paid | Partially Paid | status-pill.ts (letter case) |
| SI detail badge | VOID | VOID (raw key) | Void | status-pill.ts |
| PR detail badge | POSTED | Posted | Confirmed | status-pill.ts |
| phone DO header | LOADED | Loaded | Confirmed | owner 2026-08-22 / 08-26 |
| phone DO header | DISPATCHED | Dispatched | Loaded | owner 2026-08-26 |
| phone SI header | SENT | Sent | Submitted | owner 2026-09-12 |
| phone GRN header | POSTED | Posted | Submitted | owner 2026-09-12 |
| phone PI header | POSTED | Posted | Submitted | owner 2026-09-12 |
| phone PR header | POSTED | Posted | Confirmed | status-pill.ts |

The phone's Purchase Order and Delivery Return headers change no word. The raw-key
rows are statuses the old badge map did not list, so they printed the database
value; `ON_HOLD` is a legacy label nothing writes since mig 0324.

**Deliberately NOT changed.** The Purchase Order, Delivery Order and Delivery
Return detail pages keep their own `STAGE_LABEL`: each differs from status-pill.ts
only in letter case ("Partially received", "In transit", "Credit noted"), which is
an owner-visible choice nobody ruled on. The date rows and activity entries titled
**Posted** (`KeyDateRow k="Posted"`, `ActivityRow title="Posted"`) name the
`posted_at` timestamp, not the status, and are left alone.

**How it is pinned — each proved RED first.**

- `localStatusMapsAgree.test.ts`, new block *the header badge*: finds every
  `STAGE_LABEL: Record<string, string>` in `pages/scm-v2` by SHAPE (a new page is
  scanned the day it is written, and one the guard cannot classify fails) and
  compares each word with status-pill.ts. RED on the unfixed tree with exactly four
  findings: GRN, PI and PR POSTED, SI SENT.
- Same file, *the phone document header*: parses `DOC_MODULES` and asserts every
  module's `statusDoc`. RED on the unfixed tree: all 13 modules `<missing>`.
- `markPaidRecordsTheMoney.test.tsx` (the one harness that mounts the real Sales
  Invoice page): a SENT invoice renders "Submitted" and the text "Sent" nowhere.
  RED against `main`'s `SalesInvoiceDetailV2.tsx`, green on the fix.

**Ref.** fix/detail-badge-status-words, 2026-09-14.
