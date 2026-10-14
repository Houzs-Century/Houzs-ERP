# Houzs POS (cash & carry booth sales)

The booth POS app (`pos.houzscentury.com`, an offline-first PWA, built step by
step from `Houzs_POS_Layouts.pdf` / `POS_Build_Instructions.pdf` v3) and its
ERP side: the Cash & Carry project type, the POS Sales list on a project
page, and later the POS Admin menu. This guide carries only what is built.

## What exists

- Project type `Cash & Carry` (`project_event_types.slug = 'cash_carry'`,
  a shared master row seeded by migration `20261014T1147`). A project of
  this type sells through the POS app and has NO Sales Order module: its
  Sales section is the POS Sales list (`ProjectPosSalesSection.tsx`,
  mobile `MobilePmsPosSales.tsx`) in place of sales entries + SO block.
- Tables (public schema, integer sen): `pos_sales` (one row per receipt,
  `type SALE|RETURN`, `status PAID|VOID`, unique on device `uuid` and on
  `company_id + terminal_code + receipt_no`), `pos_sale_lines`,
  `pos_payments` (`method QR|CREDIT|DEBIT|EWALLET|CASH`, negative = refund),
  `pos_audit`. Lines and payments cascade from the bill; a bill is voided,
  never deleted.
- `GET /api/project-pos-sales/:projectId` (`routes/project-pos-sales.ts`):
  bills grouped by receipt with lines + payments, filters `date` (Malaysia
  calendar day) / `terminal` / `cashier` / `method` / `status`, totals, and
  the filter options. Pure grouping + totals in `routes/lib/pos-sales-list.ts`.

## Rules that must not break

- Read gate = the project's Sales section (`requirePageAccessOrSalesView("sales")`),
  no row scope: a booth bill belongs to the event, not the reader. Company
  scope on both the project lookup and `pos_sales.company_id`; a foreign
  project answers 404.
- Totals: `net_sen` = PAID sales minus PAID returns; a VOID bill counts only
  in `void_*`. `by_method` sums payment rows as stored (refunds negative).
  The Total Sales button writes `net_sen / 100` into
  `project_finance.total_sales` through the existing
  `PATCH /api/projects/:id/finance`, so the Project List, dashboard and
  Google Sheet sync read the booth's net takings like any other event.
- Test sales (`is_test`) never reach the ERP; the read does not filter them
  again, and the sync / import paths must keep dropping them.
- Money stays in sen on the wire; the page formats. The Disc column is a word
  (`-10%`, `-RM15`, `FOC`, `--`) computed once in `discLabel`.
- Desktop and mobile share `frontend/src/lib/projectPosSales.ts` (types,
  normalize, labels, export rows); do not keep a second copy per surface.

## Gotchas

- `/api/pos/*` (`routes/pos.ts`) is the OLDER 2990 tablet-POS auth router,
  mounted pre-auth. The booth POS endpoints of this build go under their own
  prefixes; do not extend `routes/pos.ts`.
- `project_event_types` has no company_id (shared master) — the Cash &
  Carry type shows in every company's picker on purpose.
