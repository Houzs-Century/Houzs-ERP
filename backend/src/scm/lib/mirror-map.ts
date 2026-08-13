// ----------------------------------------------------------------------------
// Shared row-transform primitives for the 2990 -> Houzs one-way mirror receivers
// (scm/routes/so-mirror.ts, amendment-mirror.ts, customer-mirror.ts,
// staff-mirror.ts, warehouse-mirror.ts).
//
// Extracted from so-mirror.ts when the amendment receiver landed. A second copy
// of these rules would be a second place to forget toPgArray (the text[] bug
// below) or to re-introduce id remapping — both are documented production 500s.
// One implementation, per-table config passed in.
//
// The rules encode the batch importer's behaviour byte-for-byte
// (scripts/migrate-2990-into-houzs.mjs), so mirrored rows and batch-imported
// rows are interchangeable:
//   (a) stamp company_id ON THE TABLES THAT HAVE ONE,
//   (b) prefix doc-NUMBER columns with `2990-`,
//   (c) force columns whose target master isn't reconciled across companies,
//   (d) drop source columns absent from the Houzs dest table (schema drift),
//   (e) copy every id (uuid and integer) AS-IS,
//   (f) RENAME a source column Houzs has renamed and 2990 has not (aliasCols).
//
// (f) is the counterweight to (d). 2990 is a separate repository on its own
// deploy schedule, so the day Houzs renames a column the old name keeps
// arriving — and (d) drops it in silence: no error, the upsert returns 200, and
// the value just stops appearing on company-2 rows. An alias is guarded on both
// sides (old name gone from dest, new name present), so it is a no-op until the
// rename lands and the fix the moment it does. See MirrorTableConfig.aliasCols.
//
// (e) is the load-bearing one. The old mirror remapped FK/self ids (uuid ->
// '2990'+slice, serial +100000), which matched NO imported row -> FK violation
// -> 500. Verbatim ids are also what make a 2990 uuid addressable from Houzs
// without a translation table.
//
// (a) is conditional and that is NOT cosmetic — see the destCols guard in
// applyMap. 0083 rules that SHARED masters get NO company_id, and scm.staff is
// one. An unconditional stamp names a column that does not exist on that table,
// which is a 500 on EVERY delivery — the same forever-wedge these receivers
// exist to prevent.
// ----------------------------------------------------------------------------
import type { Context } from 'hono';
import type { Env } from '../../types';
import { timingSafeEqualStr } from '../../services/auth';

/** The 2990 company. Mirrored rows are stamped with it on every table. */
export const C2990 = 2;

/** `2990-` + value, idempotent (a re-delivered row must not double-prefix). */
export function prefixDoc(v: unknown): unknown {
  return v == null || String(v).startsWith('2990-') ? v : `2990-${v}`;
}

// Format a JS array as a Postgres array literal: '{}' for empty, '{"a","b"}'
// otherwise. Elements are double-quoted with " and \ escaped so any text value
// is safe. Used only for genuine array-typed columns (see TableMap.arrayCols).
export function toPgArray(v: unknown[]): string {
  return `{${v.map((x) => (x == null ? 'NULL' : `"${String(x).replace(/(["\\])/g, '\\$1')}"`)).join(',')}}`;
}

/** Per-table transform rules. Every field is optional; a table with no entry
 *  still gets company_id (where the table has it) + dest-column filtering +
 *  array coercion. */
export type MirrorTableConfig = {
  /** Doc-NUMBER columns to stamp `2990-` on (never id/FK columns). */
  prefixCols?: string[];
  /** Columns forced to a FIXED value on every delivery, whether or not the
   *  source sent them — an ASSERTION about a mirrored row, not a filter on the
   *  payload. A column the source never sends (Houzs-only, e.g.
   *  so_amendments.header_changes) would otherwise be absent from the ON CONFLICT
   *  SET list and keep whatever value it already had. Listing it here is what
   *  makes "a mirrored row cannot carry this" true rather than merely expected.
   *
   *  Was `nullCols: string[]` until the masters mirror needed non-null forces
   *  (staff.active=false, warehouses.is_default=false — see those receivers for
   *  why). `{ col: null }` is the same rule it always was; widening the value
   *  rather than adding a second list keeps ONE force concept, so a reader never
   *  has to work out which of two lists wins. */
  forceCols?: Record<string, unknown>;
  /** Columns dropped from the payload entirely — HOUZS-OWNED, so a mirrored row
   *  must not state them. Unlike forceCols (which asserts a value), this asserts
   *  the mirror has NO OPINION: the column appears in neither the INSERT column
   *  list nor the ON CONFLICT SET list, so an INSERT leaves it at its default and
   *  an UPDATE leaves whatever Houzs put there untouched. Exists for
   *  scm.staff.user_id, where writing the source's (absent) value would silently
   *  unlink a migrated person — see staff-mirror.ts note 3. */
  preserveCols?: string[];
  /** Per-column value coercion, e.g. status vocabulary guards. */
  normalize?: Record<string, (v: unknown) => unknown>;
  /** INBOUND column renames: `{ nameTheSourceStillSends: nameHouzsNowHas }`.
   *
   *  The source is a SEPARATE REPOSITORY (2990) that deploys on its own
   *  schedule, so the day Houzs renames a column, 2990 keeps POSTing the old
   *  one. Rule (d) then drops it — no error, the upsert returns 200, and the
   *  value simply stops arriving. That is the quietest failure this receiver
   *  has, because nothing about the delivery looks wrong.
   *
   *  Each entry is applied ONLY when the old name is absent from the dest table
   *  AND the new name is present, so before the rename it is a proven no-op and
   *  after it is the fix — see applyMap and mirror-map.test.ts. Registering an
   *  alias early therefore costs nothing and cannot be forgotten later.
   *
   *  NOT a general column map. Use it for a rename Houzs has made and the
   *  source has not; a column that only ever existed on one side is rule (d)'s
   *  job, and it should keep being dropped. */
  aliasCols?: Record<string, string>;
};

export type TableMap = {
  prefixCols: Set<string>;
  forceCols: Record<string, unknown>;
  preserveCols: Set<string>;
  normalize: Record<string, (v: unknown) => unknown>;
  aliasCols: Record<string, string>;
  destCols: Set<string>;
  arrayCols: Set<string>;
};

/** Shared fail-closed auth for every mirror receiver: the caller is the 2990
 *  DATABASE (pg_net), not a user with a Supabase JWT, so it presents a static
 *  shared secret. Fail-CLOSED on an unset secret — an env that forgot
 *  SYNC_SECRET must reject every caller, never accept an absent header as a
 *  match for an absent secret. Five receivers repeating this by hand is five
 *  chances to write `===` against an undefined and open the route to the world. */
export function mirrorAuthed(c: Context<{ Bindings: Env }>): boolean {
  const secret = c.env.SYNC_SECRET;
  if (!secret) return false; // fail closed on unset — never match absent-vs-absent
  // Constant-time compare: this is the one mirror auth that WRITES business data
  // (SOs, customers, amendments), so match the other inbound integrations
  // (mail-inbound, assrFormIntake) rather than leak a timing side-channel on `===`.
  return timingSafeEqualStr(c.req.header('x-sync-secret') ?? '', secret);
}

/** A mapper bound to one receiver's table config, with its own dest-column
 *  cache. Per-receiver (not module-global) so two receivers can never read each
 *  other's column rules out of a shared cache. */
export type MirrorMapper = {
  tableMap(DB: Env['DB'], table: string): Promise<TableMap>;
  applyMap(row: Record<string, unknown>, m: TableMap): Record<string, unknown>;
};

export function createMirrorMapper(config: Record<string, MirrorTableConfig>): MirrorMapper {
  const mapCache = new Map<string, TableMap>();

  async function tableMap(DB: Env['DB'], table: string): Promise<TableMap> {
    const cached = mapCache.get(table);
    if (cached) return cached;

    // Destination columns — used to DROP any 2990-only source column so an INSERT
    // can't 500 on an unknown column (schema drift between the two ERPs). Read
    // from information_schema rather than assumed: the two trees drift, and the
    // scm schema was ported as pure DDL. data_type also flags Postgres array
    // columns (see arrayCols below).
    const dc = await DB.prepare(
      `SELECT column_name AS col, data_type AS dtype FROM information_schema.columns
        WHERE table_schema='scm' AND table_name=?`,
    ).bind(table).all<{ col: string; dtype: string }>();

    const rows = dc.results ?? [];
    const cfg = config[table] ?? {};
    const m: TableMap = {
      prefixCols: new Set(cfg.prefixCols ?? []),
      forceCols: cfg.forceCols ?? {},
      preserveCols: new Set(cfg.preserveCols ?? []),
      normalize: cfg.normalize ?? {},
      aliasCols: cfg.aliasCols ?? {},
      destCols: new Set(rows.map((r: { col: string }) => r.col)),
      // Postgres array-typed dest columns (e.g. mfg_sales_order_items.photo_urls
      // text[]). The D1-shim coerces a bound JS array by stringification, turning an
      // empty array [] into "" — which Postgres rejects as a malformed array literal
      // ("malformed array literal: \"\""). These must be formatted as explicit
      // Postgres array literals before binding (see toPgArray). NOTE: this is keyed
      // on data_type='ARRAY' only, so jsonb columns that happen to hold a JSON array
      // are left untouched (bound as JSON, not corrupted into a pg array literal).
      arrayCols: new Set(rows.filter((r: { dtype: string }) => r.dtype === 'ARRAY').map((r: { col: string }) => r.col)),
    };
    mapCache.set(table, m);
    return m;
  }

  /** Apply the inbound renames in TableMap.aliasCols, before the dest-column
   *  filter can drop the old name.
   *
   *  GUARDED ON BOTH SIDES, and that is what makes registering an alias early
   *  safe: `from` must be GONE from the dest table (so it can only be a stale
   *  source name, never a live column with its own meaning) and `to` must be
   *  PRESENT (so it is a real destination). Before the rename both names are
   *  the same string and `from` is still a dest column, so nothing fires and
   *  the row is returned unchanged — literally the same object.
   *
   *  A payload carrying BOTH spellings keeps the new one: the source has been
   *  deployed and is stating the value under its current name; the old key is
   *  then just a leftover the receiver has no business preferring. */
  function aliasInbound(row: Record<string, unknown>, m: TableMap): Record<string, unknown> {
    // hasOwnProperty, not `in`: the row is JSON.parse'd request body, so `in`
    // would resolve inherited Object.prototype names and rename a key that is
    // not there. Same reason so-revision guards its header_changes walk.
    const has = (o: Record<string, unknown>, k: string) =>
      Object.prototype.hasOwnProperty.call(o, k);
    let out: Record<string, unknown> | null = null;
    for (const [from, to] of Object.entries(m.aliasCols)) {
      if (from === to) continue;
      if (!has(row, from)) continue;
      if (m.destCols.has(from) || !m.destCols.has(to)) continue;
      if (has(row, to)) continue;
      out = out ?? { ...row };
      out[to] = out[from];
      delete out[from];
    }
    return out ?? row;
  }

  function applyMap(rawRow: Record<string, unknown>, m: TableMap): Record<string, unknown> {
    const row = aliasInbound(rawRow, m);
    const out: Record<string, unknown> = {};
    // Keep only columns that exist in the Houzs dest table (drop 2990-only cols).
    // Array-typed dest columns get an explicit Postgres array literal (see toPgArray).
    for (const [k, v] of Object.entries(row)) {
      if (m.destCols.has(k)) out[k] = m.arrayCols.has(k) && Array.isArray(v) ? toPgArray(v) : v;
    }
    // Drop HOUZS-OWNED columns before anything else can state a value for them.
    for (const col of m.preserveCols) delete out[col];
    // Stamp the 2990 company — but ONLY where the dest table actually has the
    // column. 0083 gives SHARED masters (scm.staff) no company_id, so an
    // unconditional stamp would name a non-existent column and 500 every delivery.
    if (m.destCols.has('company_id')) out.company_id = C2990;
    // Prefix doc-number columns; ids/FKs pass through UNCHANGED (match the import).
    for (const col of m.prefixCols) if (out[col] != null) out[col] = prefixDoc(out[col]);
    // Force columns whose target master isn't reconciled (e.g. venue_id), and
    // columns that assert a Houzs-only concept a 2990 row cannot carry. Keyed on
    // the DEST table, not on what the source happened to send, so the value lands
    // in the UPDATE set too (see MirrorTableConfig.forceCols).
    for (const [col, v] of Object.entries(m.forceCols)) if (m.destCols.has(col)) out[col] = v;
    // Per-column value coercion (status vocabulary guards).
    for (const [col, fn] of Object.entries(m.normalize)) if (col in out) out[col] = fn(out[col]);
    return out;
  }

  return { tableMap, applyMap };
}

/** Idempotent upsert. `conflict` is a comma-separated conflict target; every
 *  non-target column is overwritten from EXCLUDED, so a re-delivered outbox row
 *  converges instead of duplicating.
 *
 *  `opts.where` gates ONLY the UPDATE arm: `ON CONFLICT … DO UPDATE SET … WHERE
 *  <cond>`, where <cond> reads the EXISTING row by the table's name (Postgres
 *  exposes it there — `EXCLUDED` is the proposed row). When it is false Postgres
 *  updates nothing and RAISES NOTHING. That silence is the point: staff-mirror
 *  uses it to leave rows Houzs User Management has taken over completely alone,
 *  which must be a no-op, not an error (an error would 500 -> retry forever ->
 *  wedge). The INSERT arm is never gated: a brand-new 2990 row must always land,
 *  because that IS the bug this whole mirror fixes. */
export async function upsert(
  DB: Env['DB'],
  table: string,
  row: Record<string, unknown>,
  conflict: string,
  opts?: { where?: string },
) {
  const cols = Object.keys(row);
  const set = cols.filter((c) => !conflict.split(',').map((s) => s.trim()).includes(c))
    .map((c) => `"${c}"=EXCLUDED."${c}"`).join(', ');
  const sql = `INSERT INTO scm."${table}" (${cols.map((c) => `"${c}"`).join(',')})
    VALUES (${cols.map(() => '?').join(',')})
    ON CONFLICT (${conflict}) DO UPDATE SET ${set}${opts?.where ? ` WHERE ${opts.where}` : ''}`;
  await DB.prepare(sql).bind(...cols.map((k) => row[k])).run();
}
