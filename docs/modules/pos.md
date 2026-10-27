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
- Events tab lists every fair on its own: Cash & Carry projects, any project
  of any type that ended in the last 60 days or is still to come, and every
  linked one; each row carries a time status (`COMING` / `ON GOING` / `DONE`,
  `pos-admin-rules.ts posEventStatus`) and a separate LINKED mark; older
  projects are reachable by search. A row click opens the booth settings.
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
- The POS app itself: `pos/` (its own Vite + React app, Cloudflare Pages
  project `houzs-pos`, `pos.houzscentury.com`, deploy
  `.github/workflows/deploy-pos.yml`, CI job `pos`). Installable PWA:
  `public/sw.js` precaches the built shell (the file list and a build id are
  stamped at build), `/api` is never cached and is proxied to the Worker by
  `functions/api/[[path]].ts`. All data in IndexedDB (`src/db.ts`,
  persistent storage requested at Prepare). Screens: Device setup (P15,
  `screens/Setup.tsx`), Login (P1, `screens/Login.tsx`, tiles + PIN pad,
  PIN verified offline with `src/pin.ts`), the sell frame (P2, idle logout).
  Shared modules are imported from `frontend/src/vendor/shared` through the
  `@shared` alias, never copied a third time.
- Selling on the device (`pos/src/screens/Sell.tsx`, rules in `pos/src/cart.ts`
  and `pos/src/sale.ts`, both tested): the cart, discounts, FOC, hold /
  recall (`holdsStore.ts`), payment (`sell/Payment.tsx`: cashless methods,
  split across two, Cash with 5 sen rounding and change only when General
  enables it), the completion screen (`sell/Complete.tsx`), find bill /
  void / change salesman (`sell/FindBill.tsx`), return / exchange
  (`sell/ReturnExchange.tsx`). Every receipt is a `SaleRecord` in the
  IndexedDB `sales` store keyed by its uuid, with `synced_at` null until the
  ERP acknowledges it (step 6); the receipt counter lives in `meta`
  (`salesStore.ts`) and is bumped BEFORE the sale is written, so a number is
  never reused. Local stock = bundle snapshot + `meta.stock_adj` (sold minus
  returned since Prepare); a VOID restores it, a RETURN gives it back, an
  exchange's new items deduct.
- Receipt (`pos/src/receipt.ts`, tested) in the AutoCount layout at 32 / 48
  columns; ESC/POS bytes (`escpos.ts`, Code 128 of the receipt no); the
  printer over Web Bluetooth / WebUSB (`printer.ts`, Connect printer and
  Test print in Device setup, auto-reconnect at boot). If printing fails
  the sale is already saved: Skip print / Reconnect / Retry (P14). The
  e-receipt is the same receipt as an HTML page through the share sheet or
  Save as PDF, generated on the device (no server, so it works offline).
- Sync (`pos/src/sync.ts`, layout P14): pending receipts (`synced_at` null,
  never test sales) are pushed FIFO in batches of 50 to
  `POST /api/pos-device/sales/batch`, idempotent on the device uuid; the ERP
  answers per uuid `accepted | duplicate | updated | rejected`, and only an
  answered receipt is marked synced (a rejected one keeps its reason and
  never blocks the rest). Triggers: the `online` event verified by a ping
  (captive-portal WiFi), every sale, Sync now, a retry with backoff, the
  heartbeat timer. The heartbeat carries pending count / RM, last sync,
  receipt counter, storage and catalog version; a newer catalog version
  refreshes the bundle on the spot. The sync panel (tap Last sync) shows
  connection, pending, last sync / attempt / error, catalog version and the
  backup; Logout with pending sales asks Cancel / Sync now / Logout anyway,
  and the browser prompts on close.
- The ERP side of a synced receipt (`routes/lib/pos-sync.ts`, tested):
  the shape is validated whole or rejected; a repeat uuid is a duplicate
  unless it now says VOID (applied once, stock restored) or the salesman
  changed (updated + `pos_audit`); a receipt number already used by another
  uuid is a conflict. Inventory: OUT per unit sold (FOC included), IN per
  unit returned, reversed on void, written to `scm.inventory_movements`
  against the receipt number (`source_doc_type POS_SALE | POS_RETURN |
  POS_VOID`, `notes "POS sale T02-000279"`) at the event's stock source
  warehouse, else the General POS store; no location, or a location gone
  negative, is kept on `pos_sales.stock_warning` (the FIFO trigger records
  the short; over-sell is allowed). Idempotent per (doc type, receipt no).
- Backup (`pos/src/backup.ts`, tested): `houzs_pos_T02_backup.json`, every
  receipt AES-GCM encrypted under a key derived from the SHA-256 of the
  device token (the ERP holds that hash on `pos_terminals.token_hash`, so
  Import backup can decrypt it); written after every sale to a folder the
  admin picked once (File System Access API, Chrome), else Export backup
  downloads it.
- Device API, pre-auth, device token in `X-POS-Device`
  (`routes/pos-device.ts`): `GET /api/pos-device/ping`, `GET /prepare` (the
  bundle), `POST /heartbeat` (logged in `pos_heartbeats`; an empty device
  whose last heartbeat still had pending bills is stamped
  `db_empty_at` / `DATA_LOST`, which the watchdog turns into the critical
  alert), `POST /sales/batch` (through `routes/lib/pos-ingest.ts`). The token is minted by
  `POST /api/pos-admin/device/register` (an ERP account with `pos.manage`,
  signed in on the device during Device setup) and stored as its SHA-256
  in `pos_terminals.token_hash`; re-preparing rotates it. The bundle
  (`routes/lib/pos-bundle-load.ts`, pure part `pos-bundle.ts`) carries the
  terminal, event, company block (branding), items in scope with event
  prices and every barcode, cashiers assigned with their PIN hashes, and
  the settings.
- Sync Status (POS Admin > Sync Status, layout E7; `GET /api/pos-admin/status`):
  KPI tiles (terminals active / sales pending / pending RM / open alerts),
  one row per terminal with last seen and last sync coloured by age and a
  status word (`SYNCED`, `PENDING`, `PENDING > 3D`, `DATA LOST`, `INACTIVE`,
  `NOT PREPARED`, `routes/lib/pos-alerts.ts terminalStatusWord`), Details,
  Import backup, and the alert log with its email state; a red banner while
  a DATA_LOST alert is open, amber for the others.
- Alerts (`pos_alerts`, mig `20261014T1445`; rules in
  `routes/lib/pos-alerts.ts`, tested; runner `services/posAlerts.ts` on the
  `*/30 * * * *` cron): `PENDING_STALE` (pending > 0 and no sync for more
  than General `alert_pending_days`), `EVENT_ENDED_PENDING` (event end +
  `alert_event_end_days` passed with pending, or never synced since the
  event started), `DATA_LOST` (critical: `pos_terminals.db_empty_at` set
  by a heartbeat from an empty device that last reported pending). Each
  opens once, posts a WARNING personal notice to every active user whose
  role holds `pos.manage` or `*`, emails General `alert_email`
  (`[POS ALERT] <title> · <terminal> · <event>`) once and then once a day
  while open, and resolves on its own when no longer wanted (pending back
  to zero, device back). `POST /alerts/:id/acknowledge` closes one by hand
  AND zeroes the terminal's pending figures and `db_empty_at` (for "bills
  recovered from backup" or "device written off").
- End-of-event summary: once per linked event, when the event's end date
  has passed (Malaysia day) and every active terminal of the event shows
  zero pending, `[POS SUMMARY] <event>` goes to the alert address with
  bills, net, discount, SST, void / return counts, FOC units, by method, by
  salesman, per terminal and the top 10 items, plus a CSV attachment (opens
  in Excel; the backend has no xlsx writer) carrying the same tables and the
  by-day split. `pos_event_links.summary_sent_at` (mig `20261014T1530`) is
  the once-marker. Aggregation in `scm/shared/pos-report.ts` (tested), rows
  loaded by `routes/lib/pos-report-load.ts`; the email HTML in `routes/lib/pos-report.ts`.
- Import backup (POS Admin > Import backup, layout E8): drop
  `houzs_pos_T0x_backup.json`; `POST /api/pos-admin/backup/preview` opens
  it with that terminal's `token_hash` (`scm/shared/pos-backup-crypto.ts`,
  the one cipher the device and the ERP share) and classifies every receipt
  `NEW / UPDATE / DUPLICATE / CONFLICT / INVALID`; `POST /backup/import`
  writes NEW + UPDATE through `routes/lib/pos-ingest.ts`, the SAME ingest
  the device batch uses (classification, rows, inventory movements, audit),
  with `pos_sales.source = 'IMPORT'`, and lifts the terminal's receipt
  counter to the file's.
- Reports, one aggregation (`scm/shared/pos-report.ts`, vendored;
  `aggregateSales`, `reportRows`, `summaryCsv`, `reportHtml`): bills, net,
  gross, discount, SST, void / return counts and lists, FOC units, by
  payment method with sales / refunds / net received, by salesman, by day
  with the method split, by terminal, by item, top 10. The device report,
  the ERP Sales Report and the summary email all read it, and the CSV, the
  Excel sheets and the printable page all come from `reportRows`, so the
  four agree column for column.
- Device Sales report (layout P13, Ctrl+T, `pos/src/sell/Report.tsx`, rules
  `pos/src/report.ts`): Today / Pick date / Full event over the local bills
  (offline); All terminals (supervisor PIN) asks
  `GET /api/pos-device/report?from&to` for the event's synced bills. Print
  daily report = thermal Z-report (`zReportLines`, re-printable any time,
  no close-counter step), Export PDF (the printable page through the
  browser's print dialog), Export Excel (`write-excel-file`, lazy).
- ERP Sales Report (POS Admin > Sales Report, layout E6;
  `GET /api/pos-admin/report?project_id&from&to&terminal&salesman&status`):
  one linked event at a time; KPIs; by day with the payment columns; by
  payment method; by salesman (review only); by item with qty, FOC, gross,
  discount, net and stock left (`scm.inventory_balances` at the event's
  stock source, else the POS store, else the company total, flagged);
  Export Excel (the shared rows plus the stock column) / PDF.
- Pairing (replaces the ERP sign-in on the device): POS Admin > Terminals >
  Pair device (`POST /api/pos-admin/terminals/:id/pairing`, event must be
  set and linked) issues a one-time 8-character code, stored as a hash with
  a 15-minute expiry (`scm/shared/pos-pairing.ts`, vendored). The device
  (first screen `pos/src/screens/Pair.tsx`, or the `?pair=` link) redeems
  it at `POST /api/pos-device/pair` (pre-auth, no token yet): a fresh device
  token is minted, the code is spent, the bundle comes back. Pair again from
  Device setup (gear, supervisor PIN) moves a device; the old token dies.
- Shared, vendored byte-identical to `frontend/src/vendor/shared/`:
  `scm/shared/pos-vocabulary.ts` (payment methods, receipt status word,
  `pos-backup-crypto.ts` (the backup file cipher and shape), `pos-report.ts`
  (the report aggregation, rows, CSV and printable page),
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

- A cashier PIN is verified on the device against the bundle's hash with
  the same PBKDF2 parameters as `services/auth.ts` (100,000 iterations,
  SHA-256, 256 bits, "salt$hash" base64); five wrong PINs lock the pad
  for 30 s. The device never sends a PIN to the server.
- The ERP sign-in used by Device setup is dropped after Prepare (logout);
  only the device token stays on the device. A device whose terminal is
  deactivated, or re-prepared elsewhere, answers 401 on every device call.
- Audit: a supervisor price override (`override_by`) and a manual discount
  passed above the cap (`discount_by` per line, `bill_discount_by` per bill)
  ride on the receipt and become `pos_audit` rows at ingest
  (`pos-sync.ts auditEntriesFor`); the PIN alone is never the record.
- One ingest: a receipt enters the ERP only through
  `routes/lib/pos-ingest.ts ingestSale` (device batch and backup import
  alike). Anything that writes `pos_sales` another way breaks the
  duplicate / conflict guarantee and the stock booking's idempotency.
- Alert cadence is the rules file's, not the runner's: `wantedAlerts`
  decides what should be open, `reconcileAlerts` diffs it against
  `pos_alerts`, `emailDue` says when a mail goes (first time, then every
  24 h), `summaryDue` gates the once-per-event summary. Change thresholds in
  General, not in code; an alert never emails more than once a day.
- The summary email is sent with `outboxRetry: false`: a drained retry
  would go out without the CSV. `summary_sent_at` is stamped on `sent` AND
  on `skipped` (channel off / no key), so a disabled email channel does not
  make the cron try forever; re-enable and clear the stamp to resend.
- A backup opens only with the terminal's CURRENT `token_hash`; after a
  re-prepare the old file is unreadable by design (the key rotated with the
  token). The import never trusts the file's terminal code over the stored
  terminal: a receipt whose `terminal_code` differs is `INVALID`.

## Gotchas

- `/api/pos/*` (`routes/pos.ts`) is the OLDER 2990 tablet-POS auth router,
  mounted pre-auth, and `scm.products` / `mfg_products.pos_active` belong to
  that older retail POS. The booth POS lives under `/api/pos-admin` (and the
  device API prefixes of the later steps); do not extend `routes/pos.ts`.
- A new company-2 SKU in a single-SKU category (not sofa / bedframe /
  mattress) is created `pos_active false` (`scm/lib/new-sku-pos-active.ts`):
  off the 2990 tablet until its Modular "Show in POS" switch sends `posActive`.
  Model, SKU Master, SO and PO are unaffected.
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
