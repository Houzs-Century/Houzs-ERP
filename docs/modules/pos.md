# Houzs POS (cash & carry booth sales)

The booth POS app (`pos.houzscentury.com`, an offline-first PWA, built step by
step from `Houzs_POS_Layouts.pdf` / `POS_Build_Instructions.pdf` v3) and its
ERP side: the Cash & Carry project type, the POS Sales list on a project
page, and the POS Admin menu. This guide carries only what is built.

## What exists

- Project type `Cash & Carry` (`project_event_types.slug = 'cash_carry'`,
  a shared master row seeded by migration `20261014T1147`). A project of
  this type sells through the POS app and has NO Sales Order module: its
  Sales section is the POS Sales list (`ProjectPosSalesSection.tsx`,
  mobile `MobilePmsPosSales.tsx`) in place of sales entries + SO block.
- Sales tables (public schema, integer sen): `pos_sales` (one row per
  receipt, `type SALE|RETURN`, `status PAID|VOID`, unique on device `uuid`
  and on `company_id + terminal_code + receipt_no`), `pos_sale_lines`,
  `pos_payments` (`method QR|CREDIT|DEBIT|EWALLET|CASH`, negative = refund),
  `pos_audit`. Lines and payments cascade from the bill; a bill is voided,
  never deleted.
- `GET /api/project-pos-sales/:projectId` (`routes/project-pos-sales.ts`):
  bills grouped by receipt with lines + payments, filters `date` (Malaysia
  calendar day) / `terminal` / `cashier` / `method` / `status`, totals, and
  the filter options. Pure grouping + totals in `routes/lib/pos-sales-list.ts`.
- POS Admin menu (`/pos-admin`, sidebar System, key `pos.manage`; Owner +
  IT Admin via `*`): POS Items, Barcode labels, Cashiers, Events, SST &
  Receipt, Printer & Scanner, Terminals, General. API `/api/pos-admin/*`
  (`routes/pos-admin.ts`, rules in `routes/lib/pos-admin-rules.ts`).
  Masters (mig `20261014T1304`): `pos_items` (a `scm.mfg_products` SKU
  tagged for the booth: price, cost, AUTO discount `PCT|RM`, FOC, max manual
  discount, stock source warehouse, 24-char receipt name), `pos_item_barcodes`
  (extra barcodes, unique per company), `pos_generated_barcodes` (own EAN-13
  per SKU, sequence `pos_ean13_seq`), `pos_cashiers` (PIN hashed with
  `services/auth.hashPassword`, role `PARTTIME|SUPERVISOR`), `pos_terminals`,
  `pos_event_links` (+ `pos_event_cashiers`, `pos_event_items`,
  `pos_event_prices`), `pos_settings` (one JSON document per group).
- Shared, vendored byte-identical to `frontend/src/vendor/shared/`:
  `scm/shared/pos-vocabulary.ts` (payment methods, receipt status word,
  empty totals), `pos-settings.ts` (the three settings groups, defaults,
  normaliser), `ean13.ts` (check digit, internal prefix 200, bar pattern /
  SVG for labels).

## Rules that must not break

- Read gate of the POS Sales list = the project's Sales section
  (`requirePageAccessOrSalesView("sales")`), no row scope: a booth bill
  belongs to the event, not the reader. Every POS Admin route requires
  `pos.manage` AND the active company (`requireActiveCompanyId`, 409 when
  unresolved); every POS table carries `company_id` and every read and write
  carries the predicate. A foreign project / item / cashier answers 404.
- Totals: `net_sen` = PAID sales minus PAID returns; a VOID bill counts only
  in `void_*`. `by_method` sums payment rows as stored (refunds negative).
  The Total Sales button writes `net_sen / 100` into
  `project_finance.total_sales` through the existing
  `PATCH /api/projects/:id/finance`.
- Test sales (`is_test`) never reach the ERP; the read does not filter them
  again, and the sync / import paths must keep dropping them.
- A SKU's factory barcode stays on `scm.mfg_products.barcode`; Generate
  writes an own EAN-13 (`200` + nine-digit running number + check digit) into
  `pos_generated_barcodes` for good and onto `mfg_products.barcode` only when
  that is empty. A barcode is unique per company across the three sources;
  the device bundle collects all three per item.
- A cashier is never an ERP user: `pos_cashiers` has no link to `users`; the
  PIN is 4 to 6 digits, stored as `salt$hash` (PBKDF2, the same helper as
  passwords) so the device can verify it offline, and is never returned by
  any read. Cash is OFF by default in General (fairs are cashless).
- Settings are stored as typed documents: `PUT /settings/:group` runs the
  value through `normalizePosSettingsGroup`, so an unknown key or a
  wrong-typed value never reaches a device; readers call
  `normalizePosSettings` and get the defaults for anything missing.
- `pos_items.item_code` and `pos_sale_lines.item_code` are keep-value
  columns in `scm/lib/product-code-rename.ts`: the item's real link is
  `product_id`; the bundle re-reads the live code at prepare time.
- Money stays in sen on the wire; the page formats. The Disc column is a word
  (`-10%`, `-RM15`, `FOC`, `--`) computed once in `discLabel`.

## Gotchas

- `/api/pos/*` (`routes/pos.ts`) is the OLDER 2990 tablet-POS auth router,
  mounted pre-auth, and `scm.products` / `mfg_products.pos_active` belong to
  that older retail POS. The booth POS lives under `/api/pos-admin` (and the
  device API prefixes of the later steps); do not extend `routes/pos.ts`.
- `project_event_types` has no company_id (shared master) — the Cash &
  Carry type shows in every company's picker on purpose.
- The event drawer's terminal list shows only free terminals plus the
  event's own; a terminal serves one event at a time (`pos_terminals.project_id`).
- Label printing is client-side: an A4 sheet (5 x 9 of 40 x 30 mm) through
  the browser print dialog, or a downloaded TSPL / ZPL job; nothing talks to
  a label printer directly (`pages/pos-admin/labelPrint.ts`).
- A new string set shared by backend and frontend goes in `scm/shared/` with
  its vendored twin AND an entry in
  `backend/scripts/data/duplicated-decision-allowlist.json`.
