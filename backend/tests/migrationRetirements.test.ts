import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs helper shared with the deploy-time runner
import { planMigrationChecksums } from "../scripts/lib/migration-checksum.mjs";
// @ts-expect-error - immutable deploy-time manifest is plain ESM
import {
  RETIRED_MIGRATIONS,
  RETIRED_MIGRATION_FILENAMES,
} from "../scripts/lib/migration-retirements.mjs";

const EXPECTED_FILENAMES = [
  "0017_scm_suppliers.sql",
  "0018_scm_purchase_orders.sql",
  "0019_scm_inventory.sql",
  "0020_scm_goods_receipts.sql",
  "0021_scm_purchase_billing.sql",
  "0022_scm_transfers_stocktake.sql",
  "0023_drop_adapted_scm_island.sql",
  "0024_suppliers.sql",
  "0025_purchase_orders.sql",
  "0026_inventory_warehouse.sql",
  "0027_grns.sql",
  "0028_purchase_billing.sql",
  "0029_sales_orders.sql",
  "0030_delivery_billing.sql",
  "0031_consignment.sql",
  "0032_mrp_lead_times.sql",
  "0033_products_maintenance.sql",
  "0077_multicompany_company_id.sql",
  "0078_multicompany_views.sql",
  /* 2026-09-03: the chart relay first cut — staging-only, revert-removed; see the registry entry. */
  "0344_acc_autocount_code_migration.sql",
  /* 2026-11-11: superseded service-case cuts, staging-only via preview deploys; see the registry entry. */
  "20261109T1200_assr_supplier_return_eta.sql",
  "20261109T1300_assr_return_dos_qc.sql",
  "20261109T1700_assr_return_dos_and_qc_notes.sql",
];

// Expanded by Vite before this suite enters workerd (node:fs is unavailable
// inside the Workers test runtime). Keys are enough; no SQL module is loaded.
const LIVE_MIGRATIONS = import.meta.glob("../src/db/migrations-pg/*", { eager: false });

describe("reviewed migration retirements", () => {
  it("pins the exact 23 filenames with immutable checksum + Git provenance", () => {
    expect(RETIRED_MIGRATION_FILENAMES).toEqual(EXPECTED_FILENAMES);
    expect(new Set(RETIRED_MIGRATION_FILENAMES).size).toBe(23);
    for (const entry of RETIRED_MIGRATIONS) {
      expect(entry.archivedChecksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.gitBlob).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("proves none of the retired names is present in the live migration tree", () => {
    const liveNames = new Set(
      Object.keys(LIVE_MIGRATIONS).map((entry) => entry.split("/").pop()),
    );
    expect(liveNames.size).toBeGreaterThan(100); // guard against a vacuous glob
    expect(RETIRED_MIGRATION_FILENAMES.filter((filename: string) => liveNames.has(filename)))
      .toEqual([]);
  });

  it("accepts the exact 23 legacy tracker rows without deleting history", () => {
    const trackerRows = RETIRED_MIGRATIONS.map((entry: { filename: string }) => ({
      filename: entry.filename,
      checksum: null,
    }));
    const result = planMigrationChecksums([], trackerRows, {
      retiredMigrations: RETIRED_MIGRATIONS,
    });
    expect(result.drift).toEqual([]);
    expect(result.retired.map((entry: { filename: string }) => entry.filename))
      .toEqual(EXPECTED_FILENAMES);
  });

  it("still fails an additional unreviewed orphan", () => {
    const trackerRows = [
      ...RETIRED_MIGRATIONS.map((entry: { filename: string }) => ({
        filename: entry.filename,
        checksum: null,
      })),
      { filename: "0099_unreviewed_deleted.sql", checksum: null },
    ];
    const result = planMigrationChecksums([], trackerRows, {
      retiredMigrations: RETIRED_MIGRATIONS,
    });
    expect(result.retired).toHaveLength(23);
    expect(result.drift).toEqual([
      expect.objectContaining({
        filename: "0099_unreviewed_deleted.sql",
        reason: "legacy_file_deleted_unverifiable",
      }),
    ]);
  });

  it("retires staging's superseded preview rows by their stored checksum and still reports the live ones", () => {
    // Staging's tracker as run 42861413878 saw it: three retired cuts plus the
    // two names PR #5448 still carries, which must stay visible as leftovers.
    const stagingRows = [
      { filename: "20261109T1200_assr_supplier_return_eta.sql", checksum: "sha256:2463fe0f8200c0404d0626ba420d178cf79c1b6795fd9a560dca12415b10bf35" },
      { filename: "20261109T1300_assr_return_dos_qc.sql", checksum: "sha256:8cd225842a7df2c6449c765cb3fd1142279d38ce03f410479061dc131a072267" },
      { filename: "20261109T1700_assr_return_dos_and_qc_notes.sql", checksum: "sha256:f90999aa84b631b718bc42132f577000e6b27f61de1d2d3cc0a053bab2ae6188" },
      { filename: "20261110T1300_assr_supplier_return_eta.sql", checksum: "sha256:a6475615b9026e408e4d4e4ec00de7af90fa842477931b76ba55bda7ff73f787" },
      { filename: "20261110T1400_assr_return_dos_and_qc_notes.sql", checksum: "sha256:c504896b40a01f0341675465506b02dbb9de34e6bb07541de1f7a482ca054692" },
    ];
    const result = planMigrationChecksums([], stagingRows, {
      retiredMigrations: RETIRED_MIGRATIONS,
      previewLeftoversTolerated: true,
    });
    expect(result.drift).toEqual([]);
    expect(result.retired.map((entry: { filename: string }) => entry.filename))
      .toEqual(stagingRows.slice(0, 3).map((row) => row.filename));
    expect(result.previewLeftovers.map((entry: { filename: string }) => entry.filename))
      .toEqual(stagingRows.slice(3).map((row) => row.filename));
  });

  it("does not require retired rows on a fresh database", () => {
    const result = planMigrationChecksums([], [], {
      retiredMigrations: RETIRED_MIGRATIONS,
    });
    expect(result).toMatchObject({ pending: [], backfill: [], drift: [], retired: [] });
  });
});
