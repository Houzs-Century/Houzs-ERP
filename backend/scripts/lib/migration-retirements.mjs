/**
 * Exact historical migration files that reached at least one live tracker and
 * were later removed from the tree. The SQL remains recoverable from Git by
 * blob id; keeping it outside the live migration tree prevents a fresh database
 * from replaying this obsolete (and, for 0023, destructive) chain.
 *
 * A retirement is an immutable-history record, not a wildcard. The runner may
 * accept a missing tracker row only when its complete filename appears here and
 * its stored checksum is either legacy NULL or this archived SHA-256. The same
 * filename reappearing in the live migration directory always hard-fails.
 *
 * HOW THIS LIST WAS DERIVED (no production dump required). A tracker row can
 * only exist for a filename that was present at some first-parent tip of main,
 * because deploy.yml runs pg-migrate.mjs on push to main and nowhere else. The
 * exact commands are in docs/MIGRATION-RETIREMENTS.md — walk
 * `git rev-list --first-parent origin/main`, `git ls-tree` the migrations-pg
 * directory at each commit, take the union of basenames, and subtract the
 * basenames present on origin/main today.
 *
 * On 2026-07-22 that yields exactly the 19 filenames below. Re-run it whenever
 * a migration is deleted. Files that only ever existed inside a feature branch
 * (0093_branding_2990.sql, 0093_restore_timestamp_defaults.sql) are correctly
 * excluded: they were renumbered before their branch's merge commit, so no
 * deploy ever saw them. The same command against origin/staging yields the
 * identical 19.
 *
 * The list being wrong is nevertheless not fatal: an unknown legacy row with no
 * checksum is adopted by the one-time genesis pass in migration-checksum.mjs
 * and printed in full, rather than blocking the deploy.
 */
export const RETIRED_MIGRATIONS = Object.freeze([
  { filename: "0017_scm_suppliers.sql", archivedChecksum: "sha256:656633d7475c43679fcfad436c97e09379cbb6a856cfe3efc6726a0146623533", gitBlob: "a3b76665449b1fc102670670b7bb1e9d0d868d82" },
  { filename: "0018_scm_purchase_orders.sql", archivedChecksum: "sha256:054dba7913e58e54c79571f451272732c6b8bea421ece2d3ae03b2289b949edc", gitBlob: "b79e56cc0f06f70212a8abbe539daab0f39796fd" },
  { filename: "0019_scm_inventory.sql", archivedChecksum: "sha256:b6bdb6c7b8630098023736094e13b5536ebea243ee13124bd2ed93cd49054646", gitBlob: "0d0da006828d2730f9d3d087882515ab6aedb646" },
  { filename: "0020_scm_goods_receipts.sql", archivedChecksum: "sha256:5dc06f9bacf9a0cf83eb467b97810bf1fe177ad7938df591081b26fc8a045682", gitBlob: "24c2eb8df7af27f51937d5c63e7f83fd508d4004" },
  { filename: "0021_scm_purchase_billing.sql", archivedChecksum: "sha256:7f7afbf1dbb1871c56143e2e8176ddd18b5707b519821dddec8faa5b75025bda", gitBlob: "164a31935c555e2c26d12106657f12bb6f4dfbd0" },
  { filename: "0022_scm_transfers_stocktake.sql", archivedChecksum: "sha256:4c831b25c4381a579caeab028838c464a30e49967c76a5a8edbadd07a6bf8811", gitBlob: "0e5cc6d44f5f97d8f5660a7316cf190a427ff766" },
  { filename: "0023_drop_adapted_scm_island.sql", archivedChecksum: "sha256:1c7a0fd684c1fb3223bf6e170e3ae2b70fc6f33b5278c2615e5fa9bbe448a19a", gitBlob: "6870426489c0cbf3012bb005860055f30667d26e" },
  { filename: "0024_suppliers.sql", archivedChecksum: "sha256:cf2fed64d11b6f7464a8f2c71da60b1f8829582ed87d9d1fb9f15f288d2396c2", gitBlob: "d6d95a295f34a593a52c46ec0e2a3d6b502ebfb0" },
  { filename: "0025_purchase_orders.sql", archivedChecksum: "sha256:c01c504e85a30f6309ba27b5fd994b231aff510e817100b077569f314f08a251", gitBlob: "1bc746d99ba01c7563104144db142c2df2ea84ba" },
  { filename: "0026_inventory_warehouse.sql", archivedChecksum: "sha256:a0a3d92d10dbdca8cbf6cabda326e95a569e1fca3629548a6f42419ea8c7513b", gitBlob: "58abbe8bf03634e3f9d9294b9ec476ca28289e1c" },
  { filename: "0027_grns.sql", archivedChecksum: "sha256:8d3235745637ea963a67e547325e5479160c4b9e24c920dc603f837ce9bc1b5d", gitBlob: "2912a11e4fa0c7922b02a88525a68545ed7844e6" },
  { filename: "0028_purchase_billing.sql", archivedChecksum: "sha256:b15e488d341c25149d72116ba253e5cf26595db0bb0900c2314e3b8d24c24fbf", gitBlob: "48b5c54b0153125fe7c9f471eb78d91244cf117c" },
  { filename: "0029_sales_orders.sql", archivedChecksum: "sha256:238749fd7a10dbda5c28e426690c38569944238729d61a3cbbde40b05399811d", gitBlob: "347891980110ad20e6f980ecc28f6fa2a0769e72" },
  { filename: "0030_delivery_billing.sql", archivedChecksum: "sha256:67ee8032e4a161f595b0c82b2c4cc9d40f78c85a1cc0741b0a2638f86b41ec20", gitBlob: "4f9364ebf209e26f4df23e77422199e8cdcba56e" },
  { filename: "0031_consignment.sql", archivedChecksum: "sha256:201ae13964abf13dc0cc3cedc66788d6ede38181602eb5124bdcd5b0939104d5", gitBlob: "e14d4f91fe5cc32113c6e8a0f94d55f42e72f114" },
  { filename: "0032_mrp_lead_times.sql", archivedChecksum: "sha256:61a616ead0fda0969ef62d32cee8bfa92d5f144f256f17f3f2adb1a505fd87ed", gitBlob: "f0a870445d562c69de63a09b55ec6b52e882acc5" },
  { filename: "0033_products_maintenance.sql", archivedChecksum: "sha256:89cc7f4f90e8085b6a4d1aa123e86b34cb9471ca90ea0082c7473ca7b8bd5dde", gitBlob: "8c1a7cdf0c05c1e0ad2ad438e751459e02c863f3" },
  /* Added 2026-07-22 by the derivation above. 7368843b put these on main at
     22:18 +0800 and d2378e5f removed them at 22:25 — seven minutes in which a
     push-to-main deploy could (and most likely did) apply and track them. They
     were NOT in the original 17, so the first fail-closed run would have called
     them unverifiable drift and aborted the production deploy. */
  { filename: "0077_multicompany_company_id.sql", archivedChecksum: "sha256:76b8589cb2b8a36a05d01f2a20c3376c2f62859d8c81ad1dd271159d839f0a9e", gitBlob: "be487b68379a16545b23e1cd587bd1273f8f1562" },
  { filename: "0078_multicompany_views.sql", archivedChecksum: "sha256:ac2d9ce3ea54c269743073e6d16474967f7f412d4441634c7b3a41dc401ea8d1", gitBlob: "1e551f7c55e075a263d580a14b5c2f8c1db7078f" },
  /* Added 2026-09-03. The AutoCount chart relay's first cut: applied on
     STAGING only (run 33642779806, the #2887-corrected body), then removed
     from the tree by the #2889 revert after production refused it twice
     (docs/bugs/0614 + 0615). Production never tracked it. Its replacement,
     0346_acc_autocount_code_relay.sql, is idempotent over the state this one
     left behind — so staging needs exactly this record: the row is history,
     the file is retired, and the redo carries the work. Checksum verified
     against staging's own DRIFT line (run 33651666423). */
  { filename: "0344_acc_autocount_code_migration.sql", archivedChecksum: "sha256:e33104acb31e4e7eba46a11d4c81bc6aa6aaa4f3f84bd815579350940c76d5a0", gitBlob: "67455c29ad4fe1ccd6e87b2c9da6b436f0a38c95" },
]);

export const RETIRED_MIGRATION_FILENAMES = Object.freeze(
  RETIRED_MIGRATIONS.map((entry) => entry.filename),
);
