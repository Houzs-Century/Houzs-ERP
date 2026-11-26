import type { Context } from 'hono';
import type { Env } from '../../types';
import { timingSafeEqualStr } from '../../services/auth';

/** The 2990 company. Mirrored rows are stamped with it on every table. */
export const C2990 = 2;

/** `2990-` + value, idempotent (a re-delivered row must not double-prefix). */
export function prefixDoc(v: unknown): unknown {
  return v == null || String(v).startsWith('2990-') ? v : `2990-${v}`;
}

export function toPgArray(v: unknown[]): string {
  return `{${v.map((x) => (x == null ? 'NULL' : `"${String(x).replace(/(["\\])/g, '\\$1')}"`)).join(',')}}`;
}

/** Per-table transform rules. Every field is optional; a table with no entry
 *  still gets company_id (where the table has it) + dest-column filtering +
 *  array coercion. */
export type MirrorTableConfig = {
  prefixCols?: string[];
  forceCols?: Record<string, unknown>;
  preserveCols?: string[];
  normalize?: Record<string, (v: unknown) => unknown>;
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
  if (!secret) return false;
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
      aliasCols: {
        ...Object.fromEntries(rows
          .filter((r: { col: string }) => r.col.endsWith('_sen'))
          .map((r: { col: string }) => [r.col.replace(/_sen$/, '_centi'), r.col])),
        ...(cfg.aliasCols ?? {}),
      },
      destCols: new Set(rows.map((r: { col: string }) => r.col)),
      arrayCols: new Set(rows.filter((r: { dtype: string }) => r.dtype === 'ARRAY').map((r: { col: string }) => r.col)),
    };
    mapCache.set(table, m);
    return m;
  }

  function aliasInbound(row: Record<string, unknown>, m: TableMap): Record<string, unknown> {
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
    for (const [k, v] of Object.entries(row)) {
      if (m.destCols.has(k)) out[k] = m.arrayCols.has(k) && Array.isArray(v) ? toPgArray(v) : v;
    }
    for (const col of m.preserveCols) delete out[col];
    if (m.destCols.has('company_id')) out.company_id = C2990;
    for (const col of m.prefixCols) if (out[col] != null) out[col] = prefixDoc(out[col]);
    for (const [col, v] of Object.entries(m.forceCols)) if (m.destCols.has(col)) out[col] = v;
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
