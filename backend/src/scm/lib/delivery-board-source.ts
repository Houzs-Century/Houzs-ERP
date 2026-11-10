/* Which reads build the Delivery Planning board: the PostgREST reads it has
   always used, or the two SQL statements in delivery-board-sql.ts.

   DP_BOARD_SOURCE (wrangler.toml [vars], set explicitly there):
     rest   — the PostgREST reads only. The default, and what any missing or
              unrecognised value means.
     shadow — serve the PostgREST result; after the response, rebuild the same
              orders through SQL and record every difference (doc number + field
              names) in scm.delivery_board_shadow_runs. Nothing the user sees
              comes from SQL.
     sql    — serve from SQL. A failed SQL statement falls back to the PostgREST
              reads for that request, so the switch can never blank the board.
   The owner flips rest -> shadow -> sql only after the shadow table counts zero
   unexplained differences. */
import type { Sql } from 'postgres';
import type { Context } from 'hono';
import { getSql, resolveDatabaseUrl } from '../../db/pg';
import { paginateAll } from './paginate-all';
import { scopeToAllowedCompanies } from './companyScope';
import { bandFilter, type BandParams } from './delivery-board-window';
import { onlyDocsFilter } from './delivery-board-slice';
import { loadRegionConfig, type RegionConfig } from './delivery-board-regions';
import { loadBoardHeadSql, loadSoBoardMapsSql } from './delivery-board-sql';
import { loadSoBoardMapsRest, type SoBoardMaps, type SoBoardHeader } from './delivery-board-maps';
import { assembleSoOrders, type SoHeaderRow, type SoRowCtx } from './delivery-board-so-rows';
import { kickOffBoardReads } from './delivery-planning-board-reads';
import { planningPoNosByDoc } from './planning-po-nos';
import type { Env, Variables } from '../env';

export type BoardSource = 'rest' | 'shadow' | 'sql';
type BoardCtx = Context<{ Bindings: Env; Variables: Variables }>;

/** The switch. Anything but 'shadow' or 'sql' is the old path. */
export function parseBoardSource(raw: string | null): BoardSource {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'sql' ? v : 'rest';
}

/** The switch as this request's env sets it (a harness with no env is the old path). */
export function boardSourceOf(c: BoardCtx): BoardSource {
  const env: unknown = c.env;
  const raw = env && typeof env === 'object' ? (env as { DP_BOARD_SOURCE?: unknown }).DP_BOARD_SOURCE : undefined;
  return parseBoardSource(typeof raw === 'string' ? raw : null);
}

/** postgres.js over Hyperdrive, one per request (db/pg.ts rules: no .end()). */
export function boardSql(env: Env): Sql {
  return getSql(resolveDatabaseUrl(env));
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const warnSql = (stage: string, e: unknown) =>
  console.warn(`[delivery-planning] SQL ${stage} failed, served from PostgREST: ${errText(e).slice(0, 160)}`);

export type BoardHeadOut = { regionCfg: RegionConfig; whRows: Array<{ id: string; code: string | null; name: string | null }>; soRowsRaw: SoHeaderRow[] };

/* Region config, warehouses and the SO headers: one SQL statement, or the
   original PostgREST reads with their original 500s. */
export async function loadBoardHead(
  c: BoardCtx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  source: BoardSource,
  input: { onlyDocs: string[] | null; band: BandParams; today: string; lap: (name: string) => void },
): Promise<{ ok: BoardHeadOut } | { stage: string; err: unknown }> {
  const { onlyDocs, band, today, lap } = input;
  if (source === 'sql') {
    try {
      const h = await loadBoardHeadSql(boardSql(c.env), c, { onlyDocs, band, today }); lap('dp-head-sql');
      return { ok: { regionCfg: h.regionCfg, whRows: h.warehouses, soRowsRaw: h.soRows } };
    } catch (e) { warnSql('head', e); }
  }
  const regionCfg = await loadRegionConfig(sb); lap('dp-region');
  const { data: whRows, error: whErr } = await sb.from('warehouses').select('id, code, name'); lap('dp-warehouses');
  if (whErr) return { stage: 'warehouses', err: whErr };
  /* CROSS-COMPANY = the caller's GRANTED companies; unscoped, this read took every tenant's. */
  const { data: soRowsRaw, error: soErr } = await paginateAll<SoHeaderRow>((from, to) => bandFilter(onlyDocsFilter(
    scopeToAllowedCompanies(
      sb.from('mfg_sales_orders')
        /* NO `id` column here: scm.mfg_sales_orders is keyed by doc_no (TEXT PK) and
           has no `id` column: selecting it makes PostgREST reject the whole query and
           the board 500s. Identity here is doc_no; every join below keys on it. */
        .select('doc_no, company_id, debtor_code, debtor_name, phone, branding, status, delivery_state, agent, salesperson_id, venue, customer_state, customer_country, customer_delivery_date, sales_exemption_expiry, amend_date_from_customer, amended_delivery_date, amend_reason, amend_reason_from_customer, processing_date, so_date, address1, address2, postcode, building_type, local_total_sen, balance_sen, possession_date, house_type, replacement_disposal, referral, ref, customer_so_no, delivery_message_status, disposal_request, dp_remark, linked_ac_docno')
        .neq('status', 'DRAFT')
        .neq('status', 'CANCELLED')
        .order('customer_delivery_date', { ascending: true, nullsFirst: false })
        .order('doc_no'), // breaks date ties: pages overlapped, 7 SOs came back twice (2026-10-26)
      c,
    ).range(from, to), onlyDocs), band, today),
  ); lap('dp-so-headers');
  if (soErr) return { stage: 'sales_orders', err: soErr };
  return { ok: { regionCfg, whRows: whRows ?? [], soRowsRaw: soRowsRaw ?? [] } };
}

/* The PostgREST per-order reads, kicked off early so they overlap the sub-board
   reads (as before). Not started on the sql path. */
export function kickOffRestBoardReads(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  source: BoardSource,
  docNos: string[],
  soRows: SoBoardHeader[],
  display: boolean,
) {
  if (source === 'sql') return null;
  return {
    reads: kickOffBoardReads(sb, docNos, display),
    /* The "PO No." column walks POs per company; wrapped, since it is awaited
       later — a throw must not float unhandled. */
    poNosByDocP: planningPoNosByDoc(sb, display ? soRows : []).then((r) => ({ ok: r } as const), (e) => ({ err: e } as const)),
  };
}

export async function loadBoardMaps(
  c: BoardCtx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm service client
  sb: any,
  source: BoardSource,
  input: { docNos: string[]; soRows: SoBoardHeader[]; display: boolean; rest: ReturnType<typeof kickOffRestBoardReads>; lap: (name: string) => void },
): Promise<{ ok: SoBoardMaps } | { stage: string; err: unknown }> {
  const { docNos, soRows, display, lap } = input;
  let rest = input.rest;
  if (source === 'sql') {
    try {
      const maps = await loadSoBoardMapsSql(boardSql(c.env), c, { docNos, soRows, display }); lap('dp-data-sql');
      return { ok: maps };
    } catch (e) { warnSql('data', e); }
  }
  rest ??= kickOffRestBoardReads(sb, 'rest', docNos, soRows, display)!;
  return loadSoBoardMapsRest(sb, c, { docNos, soRows, display, reads: rest.reads, poNosByDocP: rest.poNosByDocP, lap });
}

/* ── Shadow compare ────────────────────────────────────────────────────── */

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Key-order-free JSON, so { a, b } and { b, a } compare equal (the response is JSON). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isPlainObject(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export type RowDiff = { doc_no: string; fields: string[] };

/** Per order (so_doc_no): which fields differ. Nested objects report `parent.key`. */
export function diffBoardRows(oldRows: Array<Record<string, unknown>>, newRows: Array<Record<string, unknown>>): RowDiff[] {
  const newByDoc = new Map(newRows.map((r) => [String(r.so_doc_no), r]));
  const seen = new Set<string>();
  const out: RowDiff[] = [];
  for (const o of oldRows) {
    const doc = String(o.so_doc_no);
    seen.add(doc);
    const n = newByDoc.get(doc);
    if (!n) { out.push({ doc_no: doc, fields: ['(missing in sql)'] }); continue; }
    const fields: string[] = [];
    for (const k of [...new Set([...Object.keys(o), ...Object.keys(n)])].sort()) {
      if (canon(o[k]) === canon(n[k])) continue;
      const a = o[k]; const b = n[k];
      if (isPlainObject(a) && isPlainObject(b)) {
        for (const sk of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) if (canon(a[sk]) !== canon(b[sk])) fields.push(`${k}.${sk}`);
      } else fields.push(k);
    }
    if (fields.length) out.push({ doc_no: doc, fields });
  }
  for (const n of newRows) if (!seen.has(String(n.so_doc_no))) out.push({ doc_no: String(n.so_doc_no), fields: ['(extra in sql)'] });
  return out;
}

export type ShadowInput = {
  query: string;
  served: Array<Record<string, unknown>>;
  docNos: string[];
  display: boolean;
  onlyDocs: string[] | null;
  band: BandParams;
  restMs: number;
  ctx: Omit<SoRowCtx, 'regionCfg' | 'whCode' | 'whName'>;
};

const MAX_DIFFS = 200;

/* The SQL rebuild of exactly the orders the user was served, compared field by
   field. Reads only; the one write is the result row. */
export async function runBoardShadow(sql: Sql, c: BoardCtx, s: ShadowInput): Promise<{ compared: number; diffs: RowDiff[]; error: string | null }> {
  const t0 = Date.now();
  let diffs: RowDiff[] = [];
  let error: string | null = null;
  try {
    const head = await loadBoardHeadSql(sql, c, { onlyDocs: s.onlyDocs, band: s.band, today: s.ctx.today });
    const byDoc = new Map(head.soRows.map((r) => [String(r.doc_no ?? ''), r]));
    const rows = s.docNos.map((d) => byDoc.get(d)).filter((r): r is SoHeaderRow => !!r);
    const maps = await loadSoBoardMapsSql(sql, c, { docNos: s.docNos, soRows: rows, display: s.display });
    const whCode = new Map<string, string>(); const whName = new Map<string, string>();
    for (const w of head.warehouses) { const code = (w.code ?? '').trim(); whCode.set(w.id, code); whName.set(w.id, w.name ?? code); }
    const rebuilt = assembleSoOrders(rows, maps, { ...s.ctx, regionCfg: head.regionCfg, whCode, whName })
      .map((o) => ({ ...o, ac_sales_exemption_expiry: maps.acExpiryByDoc.get(o.so_doc_no) ?? null, po_nos: maps.poNosByDoc.get(o.so_doc_no) ?? [] }));
    diffs = diffBoardRows(s.served, rebuilt as unknown as Array<Record<string, unknown>>);
  } catch (e) {
    error = errText(e).slice(0, 300);
  }
  const sqlMs = Date.now() - t0;
  try {
    await sql.unsafe(
      'INSERT INTO scm.delivery_board_shadow_runs (query, compared, differing, rest_ms, sql_ms, error, diffs) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
      [s.query, s.served.length, diffs.length, s.restMs, sqlMs, error, JSON.stringify(diffs.slice(0, MAX_DIFFS))] as never[],
    );
  } catch (e) {
    console.warn(`[delivery-planning] shadow result not recorded: ${errText(e).slice(0, 160)}`);
  }
  return { compared: s.served.length, diffs, error };
}

/** After the response: waitUntil in a Worker, a floating (caught) promise elsewhere. */
export function scheduleBoardShadow(c: BoardCtx, s: ShadowInput): void {
  const run = (async () => {
    try { await runBoardShadow(boardSql(c.env), c, s); } catch (e) {
      console.warn(`[delivery-planning] shadow skipped: ${errText(e).slice(0, 160)}`);
    }
  })();
  try { c.executionCtx.waitUntil(run); } catch { /* no execution context (tests): the promise still runs */ }
}
