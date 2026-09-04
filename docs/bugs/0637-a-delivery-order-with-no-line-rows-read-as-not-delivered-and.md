## A delivery order with no line rows read as not delivered and released a delivered order back into MRP [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** Owner, 2026-09-04: 2990-SO-2606-018 (processing 17/06, delivery
24/07, already DELIVERED, PO-2606-011 raised 18/06 and received 13/07) and
2990-SO-2606-011 (PO-2608-035 raised 29/08) both appeared on the MRP sofa view
today as SHORT — stock 0, PO outstanding 0 — as if no PO had ever been raised.
"this PO created before? SO no proceed date." The SO list showed 2606-018 as
DELIVERED with a linked PO; MRP said buy it again.

**Root cause (traced).** Three separate facts, read off production:

1. Three 2990 delivery orders — 2990-DO-2607-016 (SO-2606-018), 2607-018
   (SO-2606-033), 2607-019 (SO-2606-003) — carried `line_count` 4/1/3, header
   money and OUT inventory movements dated 2026-07-23 04:20–04:23 UTC, and
   held ZERO rows in `scm.delivery_order_items`. Their 8 rows still existed,
   parented to three header ids (`6d9ecfd5…`, `7a39eb19…`, `bd7cb486…`)
   written 2026-07-23 03:44–03:47 UTC that no longer had a header. The FK
   `delivery_order_items.delivery_order_id → delivery_orders(id)` is ON DELETE
   CASCADE and `convalidated = true`, so the rows were left behind by a writer
   that bypassed it (a header replaced under a new id, created_by = the pinned
   system staff). That writer is not in this repository's source; the Supabase
   request logs for 2026-07-23 are past retention. The same batch had been
   hand-repaired once already: DO-2607-017's 6 rows were rebuilt on 2026-08-17
   ("System (DO line rebuild)"), and the other three were missed.
2. On 2026-09-02 05:20–05:21 UTC a driver/warehouse QR scan
   (`routes/publicDoScan.ts`, one `qr_token=eq.…` lookup per document, actor =
   `SCM_SYSTEM_STAFF_ID`) marked 24 2990 delivery orders DELIVERED in 22 s. Each
   hop ran `syncSoDeliveredFromDo`. For the three empty documents `doLines` was
   `[]`, `isSoFullyCovered` returned false, the SO's stored status was DELIVERED,
   so the release arm (`!fullyCovered && canRelease`) wrote READY_TO_SHIP with the
   note "Auto: SO no longer fully delivered (DO cancelled / reduced, or goods
   returned)". Nothing had been cancelled, reduced or returned. Confirmed from
   `mfg_so_status_changes` (changed_by = the system staff, 05:21:45–05:21:48) and
   the PostgREST edge log (`query_logs`: 11 PATCH `delivery_orders` in that
   window, each followed by the sync's `mfg_sales_order_items` PATCHes).
3. MRP is a floating pool (docs/modules/mrp.md, "soft until DO"): the three
   revived SOs re-entered demand. SO-2606-018's own PO was fully received and its
   goods had shipped, so stock 0 / PO 0 → SHORT. SO-2606-003's ghost demand
   (effective delivery 24/07, earliest in the OMMBUC EZ-008 bucket) took both
   units of PO-2608-035 away from SO-2606-011 (13/09), so 2606-011 went SHORT
   too — visible in `mrp_snapshots.result->'sofaSets'`, where PO-2608-035 sat on
   2606-003 and `poNumber` was null on 2606-011.

The 24/07 the MRP row showed for SO-2606-018 is its `amended_delivery_date`
(Syasya, planning board, 2026-07-23), not a defect.

**Fix.** Data first, then three locks so the shape cannot come back.

- *Repair (prod, 2026-09-04 07:34 UTC, one transaction):* the 8 rows were
  re-parented to the live headers (`UPDATE delivery_order_items SET
  delivery_order_id …`, 4/1/3 rows, header money matched row sums exactly), the
  three SOs restored to DELIVERED, with a `mfg_so_status_changes` row and a
  `mfg_so_audit_log` row (`source = 'repair'`) each. Verified after: 0
  header-less rows in the whole table, 0 live documents with `line_count > 0`
  and no rows.
- *Database:* mig `20260904T0800_scm_do_line_integrity_lock.sql` —
  `trg_do_header_delete_lock` refuses deleting a `delivery_orders` row that has
  an OUT movement; `trg_do_line_integrity_lock` (deferred CONSTRAINT TRIGGER,
  AFTER DELETE OR UPDATE OF `delivery_order_id`) refuses ending a transaction
  with a shipped document at zero rows. Verified against prod inside a
  transaction that was rolled back: last-row delete of DELIVERED DO-2607-018
  blocked, its header delete blocked, re-parenting its sole row away blocked,
  deleting one of DO-2607-016's four rows allowed.
- *Sync:* `lib/so-delivery-sync.ts` — the release arm now runs
  `emptyLiveDeliveries` (pure, `so-delivery-sync.test.ts`, 7 cases) over every
  delivery order naming the SO; if any counts as delivered and holds no rows the
  SO is HELD at DELIVERED and a `RELEASE_REFUSED` audit row (one per SO per day)
  names the document. The test pins the 2026-09-02 shape: two SO lines, no DO
  rows → `isSoFullyCovered` false, and the guard names the empty document. On
  the unfixed tree the guard does not exist, so the release fires — that is the
  production event above, not a synthetic RED.
- *Watch:* `scripts/do-link-orphan-sentinel.mjs` (hourly) alarms on shipped
  documents with zero rows and on header-less rows, baseline 0 for both;
  `scripts/check-do-integrity.mjs` gained R5/R5b as the on-demand census.

**Ref.** fix/do-line-integrity-lock-0904, 2026-09-04.
