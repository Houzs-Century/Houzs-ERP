# Mobile gap mockups (APPROVED by the owner, 2026-07-22)

Approval-ready static mockups for the top 3 mobile coverage gaps surfaced by the
mobile parity audit. These are **design proposals only** - no application code is
changed, and no mockup ships until the owner approves it (standing rule: mockup
approval before UI code).

Every screen is a self-contained HTML file (inline CSS, no external dependencies),
framed at phone width (392px), and built on the owner-approved mobile design
language - the yardstick is `docs/mobile-prototype.html` and the shipped
`frontend/src/mobile/mobile.css` tokens (teal `#16695f` brand, gold eyebrows,
14px cards, bottom sheets, the shared in-app confirm), **not** desktop parity.
Sample data is Malaysian furniture-trade; UI is English; dates are DD/MM/YYYY;
money is RM. Interactions (tabs, sheets, confirms) are simulated with minimal
inline JS - there is no data logic.

## How to open

Double-click any file, or open it in a browser:

- `mobile-doc-create.html` - standalone document creation (DO / Sales Invoice / GRN)
- `mobile-finance-ar.html` - Finance: AR Outstanding + AP Payment Vouchers
- `mobile-hr-payout.html` - HR: team commission + payout close/reopen

Each carries a persistent "MOCKUP - pending owner approval" header note.

## Backend readiness - what already exists vs what needs building

Verified against `backend/src/scm/routes/*` (mount root `/api/scm`,
`backend/src/index.ts:274`). Every route below was confirmed by reading the
handler, not guessed.

| Capability the mockup needs | Status | Endpoint (method + path) | Source |
|---|---|---|---|
| DO blank create (customer + lines, no source SO) | EXISTS | `POST /api/scm/delivery-orders-mfg` (only `debtorName` required; items optional; ad-hoc lines allowed) | `delivery-orders-mfg.ts:2551` |
| Sales Invoice blank create | EXISTS | `POST /api/scm/sales-invoices` (`debtorName` required) | `sales-invoices.ts:796` |
| GRN blank create | EXISTS | `POST /api/scm/grns` (`supplierId` required; PO optional) | `grns.ts:1229` |
| Customer / debtor picker (typeahead) | EXISTS | `GET /api/scm/mfg-sales-orders/debtors/search?q=` | `mfg-sales-orders.ts:9752` |
| Product / SKU picker | EXISTS | `GET /api/scm/mfg-products` (client-side text filter) | `mfg-products.ts:115` |
| Warehouse from delivery STATE | EXISTS | `deriveWarehouseIdFromState` + `state_warehouse_mappings` CRUD | `mfg-sales-orders.ts:884`, `state-warehouse-mappings.ts:29` |
| AR outstanding (unpaid invoices, flat list) | EXISTS | `GET /api/scm/outstanding/si` | `outstanding.ts:51` |
| AR per-order remaining balance | EXISTS | `GET /api/scm/ar/reconciliation` | `ar-reconciliation.ts:63` |
| **AR per-customer aging buckets over unpaid invoices (0-30/31-60/61-90/90+)** | **NEEDS BUILDING** | none - the only bucketed aging (`GET /unbilled-deliveries`, `unbilled-deliveries.ts:90`) ages *pre-invoice deliveries*, not receivables | new endpoint |
| AP payment-voucher list | EXISTS | `GET /api/scm/payment-vouchers` | `payment-vouchers.ts:176` |
| AP voucher approve (= post to GL) | EXISTS | `POST /api/scm/payment-vouchers/:id/post` | `payment-vouchers.ts:444` |
| WhatsApp chase | N/A (frontend) | client-side `wa.me` deep link with pre-filled text - no backend | - |
| HR team commission (MTD) + per-person breakdown | EXISTS | `GET /api/scm/hr/commission?from&to` (per-person `kpiDetail` nested in the same response) | `hr.ts:1263` |
| HR payout close (freeze period) | EXISTS | `POST /api/scm/hr/payout/close` (perm `scm.hr.close`) | `hr.ts:1351` |
| HR payout reopen with mandatory reason | EXISTS | `POST /api/scm/hr/payout/reopen` (perm `scm.hr.reopen`; `reason` required by schema `hr.ts:1489` and by the DB, mig 0125) | `hr.ts:1503` |

## 1. `mobile-doc-create.html` - standalone document creation

**Gap it closes (parity audit rank #1).** Mobile can list Delivery Orders, Sales
Invoices and GRNs, and can create them **only by converting a source document**
(`MobileConvertWizard`: SO->DO, DO->Invoice, PO->GRN). There is no way to start a
document from scratch on a phone - no `MobileNewDO` / `MobileNewInvoice` /
`MobileNewGRN` screen exists. The mockup adds the missing blank-create path: a `+`
on the SCM Documents list opens a doc-type sheet (DO / Sales Invoice / GRN), then a
DO blank-create flow - customer picker (empty state), line items via product search
(empty state), delivery State driving a read-only Sales Location (the
State-decides-warehouse rule, mirroring `MobileNewSO.tsx:2110`), and a review step
gated by an in-app confirm (no naked save).

**Backend vs build.** All server work already exists: blank-create for all three
docs (`POST /delivery-orders-mfg`, `/sales-invoices`, `/grns` - each needs only the
party, upstream link optional), debtor search, product list, and
state->warehouse resolution. **Nothing new is needed on the backend.** Scope is
**frontend only**: three mobile create screens plus the entry point, reusing the
customer/line/state patterns already proven in `MobileNewSO.tsx`. Estimate: build DO
first (~2-3 days FE incl. the shared doc-type entry sheet), then SI and GRN reuse the
same shell (~1-1.5 days each).

## 2. `mobile-finance-ar.html` - Finance on mobile

**Gap it closes (parity audit rank #2).** Finance has no mobile presence at all. The
mockup delivers two panes behind one segmented control. **AR Outstanding**: a total
hero, aging buckets (0-30 / 31-60 / 61-90 / 90+), a per-customer list, and a
customer drill-in showing that customer's aging plus its unpaid-invoice list, with a
**WhatsApp payment-reminder** shortcut (a concept: it opens WhatsApp with a
pre-filled message - nothing is sent without the user's tap, respecting the
send-a-message boundary). **AP Payment Vouchers**: a draft/posted list and a voucher
detail whose approve action posts to the ledger, gated by an in-app confirm.

**Backend vs build.** AP is ready: list (`GET /payment-vouchers`) and approve
(`POST /payment-vouchers/:id/post`, where "post to GL" is the approve action) both
exist - **AP is frontend only**. AR is mostly ready but has the one genuine backend
gap in this whole set: outstanding invoices can be listed (`GET /outstanding/si`) and
per-order remaining balances read (`GET /ar/reconciliation`), but **there is no
endpoint that aggregates unpaid invoices per customer into 0-30/31-60/61-90/90+
aging buckets** - the only bucketed-aging code (`unbilled-deliveries.ts`) ages
delivered-but-uninvoiced goods, not receivables. WhatsApp chase is a client-side
`wa.me` deep link (no backend). Estimate: **1 new AR aging endpoint** (a debtor-
grouped aggregation over unpaid SIs; the bucket math can be copied from
`unbilled-deliveries.ts:90`) at ~1-2 days BE, plus ~3-4 days FE for both panes and
the drill-in.

## 3. `mobile-hr-payout.html` - HR commission for managers

**Gap it closes (parity audit rank #3).** Managers have no mobile view of team
commission or payout control. The mockup shows a team month-to-date list grouped by
showroom, a per-person breakdown (personal / showroom-override / item-KPI, plus the
contributing orders), and the payout lifecycle: **Close** freezes the period (in-app
confirm summarising who and how much is frozen), and once closed the action becomes
**Reopen**, a danger action requiring a **mandatory reason** - the confirm button
stays disabled until a reason is entered.

**Backend vs build.** Everything the mockup does already exists on the server. Team
commission and the per-person breakdown come from one call
(`GET /hr/commission?from&to`, with `kpiDetail` nested per person - ideal for a
phone). Close and reopen are real, permissioned endpoints
(`POST /hr/payout/close`, `POST /hr/payout/reopen`). Notably the mockup's mandatory
reopen reason is not invented - the reopen endpoint already **requires** a `reason`
(zod `min(1)`, `hr.ts:1489`) and persists it to the audit trail
(`reopen_reason`, `reopened_by_*`), enforced at the DB level too (mig 0125). **No new
backend.** Scope is **frontend only**: list + detail + the two approval flows, gated
on the existing `scm.hr.close` / `scm.hr.reopen` permissions. Estimate: ~2-3 days FE.

## Design fidelity notes

- Tokens, cards, badges, chips, bottom sheets, the dark hero, the stepper, and the
  in-app confirm are ported from `mobile.css` / the approved prototype so the
  mockups read as this app, not generic Material.
- No naked saves: every create/approve/close/reopen passes through the shared
  confirm pattern (`useConfirm` equivalent), matching the house rule.
- No emoji anywhere in these files (owner rule). The WhatsApp glyph is an inline SVG,
  not an emoji.
