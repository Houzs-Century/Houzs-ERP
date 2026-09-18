# Document status vocabulary

The one home for what word each document shows for its "this is no longer a
draft" step, what the delivery date is called, how a hold differs from a
status, and how the branding chip picks its colour. Read this before adding a
status pill, filter tab, print label, or hold control to any document.

## Statuses and flow

**Stored enum value vs. displayed word** (the stored value is permanent and
must never change; only the label changes):

| document | stored | shown |
|---|---|---|
| Sales Order | `CONFIRMED` | Submitted |
| Purchase Order | `SUBMITTED` | Submitted |
| GRN | `POSTED` | Submitted |
| Purchase Invoice | `POSTED` | Submitted |
| Purchase Return / Stock Transfer / Stock Take | `POSTED` | Confirmed |
| Payment Voucher | `POSTED` | **Approved** (the one exception) |
| Sales Invoice | `SENT` | Submitted |
| Delivery Order | `LOADED` | Confirmed |

**The Delivery Order's own 3-scan ladder** (one QR, scanned three times, one
rung at a time, no skipping): `DRAFT` —Confirm loading→ `LOADED` (shows
*Confirmed*) —Confirm Loaded→ `DISPATCHED` (shows **Loaded**) —Confirm
Departure→ `IN_TRANSIT` —Confirm Delivered→ `DELIVERED`. Stock OUT fires once,
on first entry into `LOADED` — every later rung is a status-only move.

**Only four manual status moves are ever offered to a person** (Sales
Order): **Confirm**, **Hold**, **Close remaining**, **Cancel** — a status a
machine derives (`READY_TO_SHIP`, `DELIVERED`) is never offered as a button.
`IN_PRODUCTION` / `SHIPPED` / `INVOICED` have no writer at all today (their
buttons were removed, not merely hidden). The Delivery Order carries three
*additional*, dated, temporary manual moves (Mark Loaded / In Transit /
Delivered) as groundwork ahead of full automation — none of them move stock,
because stock already left at `LOADED`.

`SHIPPED` **folds into Delivered** on the Sales Order display (folds, not
deleted — the enum value stays legal and is still written).

**Close remaining ≠ Cancel**: Close leaves the document standing (what was
delivered/invoiced stays real, still earns commission); Cancel voids the
document and unwinds it (any deposit becomes customer credit). The two are
orthogonal to Hold — any combination of Hold with either is allowed.

**A hold is a marker, not a status** — `on_hold` / `hold_reason` / `held_at`
/ `held_by` columns, independent of `status` in both directions.
`ON_HOLD` remains a legal-but-retired enum label on the four documents that
used to write it (Postgres cannot drop an enum value) — still rendered for
any legacy row, never written again.

## Permissions

This module owns no permission keys of its own — every status/hold action
rides the gate the underlying document route already enforces (see that
document's own guide, e.g. `payment-voucher.md`, `service-case.md`).

## Rules that must not break

- **Stored enum values never change** — only display-label maps change.
  Renaming a column was costed at 2-3 weeks against 1-2 days for a label
  sweep, because AutoCount, every report/export, and every historical
  document reads the stored value.
- `DISPATCHED` shows **Loaded**, `LOADED` shows **Confirmed** — do not swap
  them, and never label `DISPATCHED` "Shipped" (that claims the truck has
  already left, one step early).
- A hold write must never touch `status`; a status write (a real progress
  re-derivation, e.g. `recomputePoReceived`, `DELIVERABLE_FROM`) must never
  read or clear `on_hold`. The two columns are orthogonal by design.
- Every "may somebody ACT on this document" guard must read
  `isDocumentHeld` (flag OR legacy `ON_HOLD` label) explicitly — since hold
  stopped overwriting status, a receivable/billable read that used to get
  this for free (via an allow-list of statuses) now needs its own
  `on_hold = false` filter.
- Nothing may write the enum label `ON_HOLD` again on any of the four
  documents that carry it — refused with `hold_is_not_a_status`; the label
  is retained for reading only.
- `CLOSED` is deliberately **unranked** in the Sales Order transition table
  — `CLOSED → DRAFT` must stay an explicit refusal, or an unranked status
  falls through the rank check and the move is silently allowed.
- A `*_STATUS_BUCKETS` map on any list with no catch-all tab must partition
  its enum **exhaustively** — an unbucketed value is invisible on every tab
  and silently missing from the header count.
- A printed document reads its status via `statusLabel(docType, status)`
  from the shared vocabulary — never by title-casing the raw stored value.
- The Branding chip's colour is decided by **what the line IS** (its
  category bucket: Sofa / Bedframe / Mattress / other) — never by
  string-matching the brand-name text.

## Gotchas

- A confirm-step rename touches three estates that each fail differently —
  CODE (loud, build/CI), RULES/enum (blocking, decides rename order), DATA
  (silent, a list just stops showing rows). Measure with
  `check-status-vocabulary.mjs` before estimating a rename; do not guess.
- Collapsing a page's own status-word map onto the canonical one
  (`status-pill.ts`) is a **decision per page**, not a mechanical refactor —
  some differ only in letter case or a different map key, and that has not
  been ruled on. Use `withStatusLabels(docType, ownMap)` and check
  `localStatusMapsAgree.test.ts` before assuming two maps already agree.
- A detail page's header badge is sometimes a **third, differently-shaped**
  copy (a flat `Record<string,string>`) that the usual map-comparison guard
  cannot parse — check for this shape explicitly; it hid stale words
  (Posted/Sent) after the pill and the filter tab were already fixed.
- The mobile module-detail header pill title-cases the raw stored value
  unless the module declares `statusDoc` to opt into the shared label —
  consignment modules pass `null` deliberately, to keep their own words.
- `brandingToneForLabel` is a fallback bridge for surfaces (Sales Invoice,
  Delivery Order, Delivery Return) that carry only label text, not a real
  category — it is not reliable for an arbitrary brand name (e.g. "ZANOTTI"
  resolves to OTHER). The real fix is adding the line category to those
  payloads, not extending the text bridge further.
- The item-code concept's `allow` list includes `src/scm/lib/product-code-rename.ts` and `scripts/probe-product-code-columns.mjs`: they must name the dead `public` copies' `material_code` / `product_code` columns.

## Where the code is

- `frontend/src/vendor/scm/lib/status-pill.ts` — the canonical status→label
  map, used by pills, badges and printed documents.
- `backend/src/scm/lib/document-hold.ts`, `document-hold-route.ts`,
  `backend/src/scm/routes/document-hold-routes.ts` — the hold marker, its
  one PATCH handler, and its mount across all five hold-bearing documents.
- `backend/src/scm/lib/source-document-gates.ts` — the four
  conversion gates (SO→DO, SO→PO, PO→GRN, GRN→PI) that must read the hold
  marker.
- `frontend/src/vendor/scm/components/HoldChip.tsx`,
  `frontend/src/vendor/scm/lib/document-hold-queries.ts` — the Hold chip and
  its one mutation.
- `frontend/src/pages/scm-v2/use-hold-action.ts`,
  `frontend/src/pages/scm-v2/row-menus.ts`,
  `frontend/src/pages/scm-v2/do-list-status.ts` — hold confirm wording, menu
  entries, the DO's `on_hold` list tab.
- `frontend/src/lib/brandingTone.ts` — the one branding-chip colour rule.
- `backend/src/scm/lib/so-lifecycle-guards.ts`,
  `backend/src/scm/lib/so-tab-statuses.ts` — Close/Cancel guards, the
  `SHIPPED`-folds-into-Delivered bucket.
- `backend/scripts/lib/vocabulary.mjs` — the name registry (Delivery Date /
  Processing Date and any future named concept belong here).
- `backend/scripts/check-status-vocabulary.mjs` — the rename-impact census.
- `frontend/src/pages/scm-v2/DoLoadScan.tsx` — the Delivery Order's 3-scan
  ladder screen.
