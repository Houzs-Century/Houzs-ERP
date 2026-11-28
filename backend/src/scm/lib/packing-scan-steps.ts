import { scopeToCompanyId } from './companyScope';
import { normalizePlate } from './plate-normalize';
import type { ResolvedLorryDayScan } from './lorry-day-scan';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as lorry-day-scan.ts
type Db = SupabaseClientGeneric<any, any, any>;

/** The two scans of a printed lorry or region sheet (owner 2026-11-28): prepared first,
 *  then loaded. Rules in docs/modules/delivery-tms.md. */
export type PackingScanStep = 'prepare' | 'load';

/** PURE. What the next scan of a sheet records. */
export function nextPackingScanStep(preparedAt: string | null, loadedAt: string | null): PackingScanStep | 'done' {
  if (!preparedAt) return 'prepare';
  if (!loadedAt) return 'load';
  return 'done';
}

export const PACKING_SCAN_STALE_PREPARE =
  'This packing list has not been marked prepared yet, so it cannot be loaded. Reload the page.';
export const PACKING_SCAN_STALE_DONE =
  'This packing list was already marked loaded. Reload the page to see the times.';

export type PackingScanStepCheck =
  | { ok: true; step: PackingScanStep; already: boolean }
  | { ok: false; status: 400 | 409; code: 'step_required' | 'stale_step'; message: string };

/**
 * PURE. Checks the step a scan page pressed against the sheet's state. A second press
 * of "prepared" while the sheet waits for loading is answered as already done (a double
 * tap); any other mismatch is a stale page and is refused with a plain reload message.
 * `legacyTo` is the old one-step body (`to: DISPATCHED`), read as a load.
 */
export function checkPackingScanStep(
  asked: unknown,
  legacyTo: string | null,
  preparedAt: string | null,
  loadedAt: string | null,
): PackingScanStepCheck {
  const step: PackingScanStep | null = asked === 'prepare' || asked === 'load'
    ? asked
    : asked === undefined && legacyTo === 'DISPATCHED' ? 'load' : null;
  if (!step) {
    return { ok: false, status: 400, code: 'step_required', message: 'This scan did not say which step it records. Reload the page and try again.' };
  }
  const next = nextPackingScanStep(preparedAt, loadedAt);
  if (step === next) return { ok: true, step, already: false };
  if (step === 'prepare' && next === 'load') return { ok: true, step, already: true };
  return {
    ok: false,
    status: 409,
    code: 'stale_step',
    message: next === 'prepare' ? PACKING_SCAN_STALE_PREPARE : PACKING_SCAN_STALE_DONE,
  };
}

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** PURE. "2026/11/28 09:42" in Malaysia time (UTC+8, no daylight saving), or '' for no time. */
export function fmtMalaysiaTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = new Date(t + MYT_OFFSET_MS).toISOString();
  return `${s.slice(0, 4)}/${s.slice(5, 7)}/${s.slice(8, 10)} ${s.slice(11, 16)}`;
}

export type SheetStampResult = { status: 'ok'; at: string } | { status: 'read_failed' };

async function stampOnce(
  sb: Db,
  sheet: ResolvedLorryDayScan,
  column: 'prepared_at' | 'loaded_at',
  now: string,
): Promise<SheetStampResult> {
  const patch = column === 'prepared_at' ? { prepared_at: now, prepared_by_scan: true } : { loaded_at: now };
  const { data: claimed, error: claimErr } = await scopeToCompanyId(
    sb.from('packing_scan_sets').update(patch).eq('id', sheet.id).is(column, null),
    sheet.companyId,
  ).select(column).maybeSingle();
  if (claimErr) return { status: 'read_failed' };
  const won = (claimed as Record<string, string | null> | null)?.[column];
  if (won) return { status: 'ok', at: won };
  const { data: after, error: readErr } = await scopeToCompanyId(
    sb.from('packing_scan_sets').select(column).eq('id', sheet.id),
    sheet.companyId,
  ).maybeSingle();
  if (readErr) return { status: 'read_failed' };
  const kept = (after as Record<string, string | null> | null)?.[column];
  return kept ? { status: 'ok', at: kept } : { status: 'read_failed' };
}

/** Records the prepared time once (a second tap keeps the first time). Writes no DO. */
export function markSheetPrepared(sb: Db, sheet: ResolvedLorryDayScan, now: string): Promise<SheetStampResult> {
  return stampOnce(sb, sheet, 'prepared_at', now);
}

/** Records the loaded time once, after the whole-lorry load ran. */
export function markSheetLoaded(sb: Db, sheet: ResolvedLorryDayScan, now: string): Promise<SheetStampResult> {
  return stampOnce(sb, sheet, 'loaded_at', now);
}

/** One lorry's or region's scan times for a day, for the office's Packing Lists tab. */
export type PackingScanStatus = {
  kind: 'lorry' | 'region';
  key: string;
  prepared_at: string | null;
  loaded_at: string | null;
};

export type PackingScanSetRow = {
  sheet_kind: string | null;
  lorry_plate: string | null;
  region: string | null;
  prepared_at: string | null;
  loaded_at: string | null;
  qr_revoked_at: string | null;
};

const earlier = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(b) < Date.parse(a) ? b : a);
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a);

/**
 * PURE. Every printed sheet of a day folded to one line per lorry (key = normalised
 * plate) and per region (key = region key). A lorry re-printed with a different DO set
 * has several sheets: it reports the earliest prepared time and the latest loaded time.
 * Revoked sheets are ignored.
 */
export function aggregatePackingScanStatus(rows: readonly PackingScanSetRow[]): PackingScanStatus[] {
  const out = new Map<string, PackingScanStatus>();
  for (const r of rows) {
    if (r.qr_revoked_at) continue;
    const kind = r.sheet_kind === 'region' ? 'region' : 'lorry';
    const key = kind === 'region' ? String(r.region ?? '').trim() : normalizePlate(r.lorry_plate);
    if (!key) continue;
    const id = `${kind}:${key}`;
    const prev = out.get(id);
    out.set(id, {
      kind,
      key,
      prepared_at: earlier(prev?.prepared_at ?? null, r.prepared_at ?? null),
      loaded_at: later(prev?.loaded_at ?? null, r.loaded_at ?? null),
    });
  }
  return [...out.values()];
}

export type PackingScanStatusResult = { status: 'ok'; sheets: PackingScanStatus[] } | { status: 'read_failed' };

/** The day's sheets of one company, folded by aggregatePackingScanStatus. */
export async function loadPackingScanStatus(sb: Db, companyId: number, date: string): Promise<PackingScanStatusResult> {
  const { data, error } = await scopeToCompanyId(
    sb.from('packing_scan_sets')
      .select('sheet_kind, lorry_plate, region, prepared_at, loaded_at, qr_revoked_at')
      .eq('delivery_date', date),
    companyId,
  );
  if (error) return { status: 'read_failed' };
  return { status: 'ok', sheets: aggregatePackingScanStatus((data ?? []) as PackingScanSetRow[]) };
}
