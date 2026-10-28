/* Mirror of src/scm/shared/so-processing-date.ts, for the .mjs audits — same
   reason so-terminal-states.mjs and do-shipped-states.mjs exist: a plain .mjs
   script cannot import TypeScript. tests/soProcessingDateMirror.test.ts is the
   pin, and tests/soProcessingDateOneName.node.mjs is the gate that stops a NEW
   script hand-typing the retired name.

   Read that TS file's header before changing anything here. Only the NAMES are
   mirrored: the pair rule, the refusal codes and canonicaliseSoHeaderChanges
   stay on the TS side, because no script enforces them.

   WHY THE SCRIPTS NEEDED THIS. Migration 0286 renamed
   scm.mfg_sales_orders.internal_expected_dd -> processing_date (applied on prod
   2026-08-13T13:46:59Z) and eleven scripts under backend/scripts went on naming
   the old one. A column that does not exist is 42703, and 42703 fails the WHOLE
   statement — so an audit that reports "0 defects" after one is not reporting a
   smaller truth, it is reporting nothing at all. */

/** The DB column on scm.mfg_sales_orders (and the consignment twin) behind the
 *  UI's "Processing Date". */
export const SO_PROCESSING_DATE_COLUMN = "processing_date";

/** The camelCase key the header PATCH and amendment payloads carry it under. */
export const SO_PROCESSING_DATE_PAYLOAD_KEY = "processingDate";

/** Column names an inbound payload — or a row written before 0286 — may still
 *  use for this date. NOT a name to query by: the column is gone. */
export const SO_PROCESSING_DATE_LEGACY_COLUMNS = ["internal_expected_dd"];

/** Payload keys frozen inside stored jsonb (so_amendments.header_changes,
 *  mfg_so_audit_log.field_changes), mapped onto the key the code reads today. */
export const SO_HEADER_LEGACY_PAYLOAD_KEYS = {
  internalExpectedDd: SO_PROCESSING_DATE_PAYLOAD_KEY,
};

/**
 * The column name as a postgres.js SQL FRAGMENT, for splicing into a tagged
 * template.
 *
 * THIS IS NOT CEREMONY. postgres.js binds `${aString}` as a PARAMETER, so
 * `` sql`WHERE h.${SO_PROCESSING_DATE_COLUMN} IS NOT NULL` `` sends
 * `WHERE h.$1 IS NOT NULL` and the server rejects it — the failure is loud but
 * it is nowhere near the line you would look at. A Query object nested in a
 * template is inlined VERBATIM instead, which is what this returns.
 *
 * Not `sql(name)` either: that path picks a builder by regex-matching the SQL
 * text already emitted, so the same call renders an identifier after `SELECT`
 * and garbage after `IN (`. Every one of these queries has an `IN (...)` in it.
 *
 * The returned Query is never awaited, so it never executes.
 */
export const soProcessingDateFragment = (sql) => sql.unsafe(SO_PROCESSING_DATE_COLUMN);
