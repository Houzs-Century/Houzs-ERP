/**
 * Load the migration tracker without violating a read-only diagnostic.
 *
 * postgres.js query clients are callable tagged-template functions, so keeping
 * this in a small dependency-injected helper lets tests prove that dry-run and
 * verify-only execute SELECTs only against every legacy tracker shape.
 */
export async function loadAppliedMigrationRows(pg, { readOnly }) {
  if (!readOnly) {
    await pg`CREATE TABLE IF NOT EXISTS _pg_migrations (
      filename text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await pg`ALTER TABLE _pg_migrations ADD COLUMN IF NOT EXISTS checksum text`;
    return pg`
      SELECT filename, checksum
      FROM _pg_migrations
      ORDER BY filename
    `;
  }

  const [tracker] = await pg`
    SELECT
      to_regclass('_pg_migrations') IS NOT NULL AS tracker_exists,
      EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = to_regclass('_pg_migrations')
          AND attname = 'checksum'
          AND NOT attisdropped
      ) AS checksum_exists
  `;
  if (!tracker?.tracker_exists) return [];

  if (tracker.checksum_exists) {
    return pg`
      SELECT filename, checksum
      FROM _pg_migrations
      ORDER BY filename
    `;
  }
  return pg`
    SELECT filename, NULL::text AS checksum
    FROM _pg_migrations
    ORDER BY filename
  `;
}
