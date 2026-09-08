## The migrated delivery orders carried no customer card at all [medium]

<!-- area: Cutover + migrated data -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-08, on `HC-DO-011559` (Na E Chuen, mirrors
AutoCount `DO-011559`, `DELIVERED`): 「为什么DO没有显示客户信息」. The quick-view
drawer's CUSTOMER & DELIVERY card showed Phone / Email / Address all "—", and so
did Salesperson, Expected At and Delivery Date in the header block. The printed
DO (dot-matrix layout, 2026-09-08) had the same holes: `Address: —`, `Tel: —`.
The line items, the SO link and the amounts were all right.

**Root cause (traced).** The document was written by the migrated writer —
the `mirrors AutoCount delivery …` note is `doNote()` in
`backend/scripts/lib/migrated-do-writer.mjs`, and only that writer emits it.
Its INSERT (`insertMigratedDo`, formerly inline in
`create-migrated-documents.mjs:311-320`) named twelve header columns:
`do_number, so_doc_no, debtor_code, debtor_name, status, do_date, currency,
company_id, created_by, notes, migrated_no_stock, linked_ac_docno` (+
`warehouse_id, sales_location` since #3121). Not one of the customer / delivery
columns.

The interactive path snapshots them all. `POST /delivery-orders-mfg/from-sos`
(`backend/src/scm/routes/delivery-orders-mfg.ts:3932-3955`) copies `address1`,
`address2` (falling back to `address3 + address4`), `city`, `state`,
`customer_state`, `customer_country`, `postcode`, `phone`, `salesperson_id`,
`agent`, `email`, `customer_type`, `building_type`, `branding`, `venue`,
`venue_id`, `ref`, the emergency contact and `customer_delivery_date` /
`expected_delivery_at` from the SO header, through the shared mapping in
`backend/src/scm/lib/so-to-do-fields.ts`. The migrated writer never did, so the
columns are NULL on the row.

The UI reads the DO's OWN columns and does not fall back to the SO — drawer at
`frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx:518-523` (`row.phone`,
`row.email`, `row.address1…`), and the print template the same — so a NULL row
is a blank card. That is correct behaviour for a snapshot document; the defect
is upstream, in what was snapshotted.

**Why it stayed hidden.** Two earlier repairs touched this exact writer and
stopped one column short each time: #1886 ("a migrated delivery order is
addressed to someone") added the `debtor_name` fallback because that column is
NOT NULL and the insert failed loudly; `backfill-do-line-snapshot.mjs`
(docs/bugs/0043) fixed the LINE snapshot (`item_group`, `variants`,
`description2`). The HEADER snapshot is nullable end to end, so nothing failed
and nothing measured it. Every `migrated_no_stock = true` DO in company 1 is
affected — not one document.

**Fix.** Three parts, one mapping.

1. `backend/scripts/lib/migrated-do-header-snapshot.mjs` — the script-side twin
   of `so-to-do-fields.ts`: `SO_HEADER_SNAPSHOT_COLS`, `DO_HEADER_SNAPSHOT_COLS`,
   `soHeaderToDoSnapshot(so, { doDate })`. Same derivations (address2 fallback,
   `state` = `customer_state`, phones E.164 via `lib/phone-normalise.mjs`,
   `expected_delivery_at` falls back to the DO date). **`sales_location` and
   `warehouse_id` are deliberately excluded** — on a migrated DO they are the
   ship-from branch from the book (owner 2026-09-07, 「记在单头就好」), not the
   SO's sales branch.
2. `insertMigratedDo` takes `soHeader` and spreads the snapshot into the
   INSERT. Both callers load the whole SO header where they used to load only
   `debtor_name` and pass it: `create-migrated-documents.mjs` (`soHead`) and
   `sync-ac-delta.mjs` (`doSoHead`).
3. `backend/scripts/backfill-migrated-do-header.mjs` +
   `.github/workflows/backfill-migrated-do-header.yml` (Actions → **Backfill
   migrated DO header snapshot from the SO**) for the rows already written.
   DRY-RUN by default, `apply=1` writes; `scope` migrated|all; `do_number` to
   limit to one document. Every SET is guarded by its own `IS NULL`, so a
   header a human already corrected is never overwritten. Where the SO is
   itself blank the DO stays blank and the plan names the column — that is an
   SO-side gap, not something to invent. Independent read-back after the
   write.

Pinned by `backend/tests/migratedDoHeaderSnapshot.test.mjs`: the mapping
agrees with the TypeScript one field by field; both callers pass `soHeader:`;
the writer spreads the snapshot; the backfill imports the shared module rather
than carrying a private copy; `sales_location` is not in the set. The
source-text assertions fail on the unfixed tree (no `soHeader` anywhere).

**Ref.** `fix/migrated-do-header-snapshot-0908`, 2026-09-08. Related:
docs/bugs/0043 (line snapshot, same writer), #1886 (debtor name, same writer),
#3121 (ship-from branch, the column this fix must NOT touch).
