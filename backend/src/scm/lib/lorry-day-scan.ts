// The packing list printed per lorry per delivery day (scm.packing_scan_sets): the
// QR on it names the delivery orders PRINTED on that sheet, so its scan loads those
// and no others. A DO whose lorry changed after printing is left alone and reported.
// Owner 2026-11-27 ("scan了就是全部loaded了"); rules in docs/modules/delivery-tms.md.
//
// Minting is authenticated and company-scoped on every DO id; the public scan only
// resolves (do-scan-token.ts resolveScanToken) and reads.
import { newDoScanToken, type TripScanMember } from './do-scan-token';
import { scopeToCompanyId } from './companyScope';
import { normalizePlate } from './plate-normalize';
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as lorry-day-runs.ts
type Db = SupabaseClientGeneric<any, any, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** At most this many DOs on one printed sheet (the public scan's basket cap). */
export const LORRY_DAY_MAX_DOS = 60;

/** Which part of a split sheet (over LORRY_DAY_MAX_DOS DOs) was printed; null for a whole sheet. */
export type SheetPart = { no: number; count: number };

/** Most parts one sheet can be split into (the migration's CHECK). */
export const MAX_SHEET_PARTS = 50;

export type LorryDaySheetInput = { lorryPlate: string; deliveryDate: string; doIds: string[]; part: SheetPart | null };

/** A sheet printed per Delivery Planning region per delivery day (no lorry check on its scan). */
export type RegionDaySheetInput = { region: string; deliveryDate: string; doIds: string[]; part: SheetPart | null };

type DayAndDos = { ok: true; deliveryDate: string; doIds: string[]; part: SheetPart | null } | { ok: false; message: string };

const PART_RE = /^\d{1,2}$/;

function parsePart(b: { part?: unknown; parts?: unknown }): { ok: true; part: SheetPart | null } | { ok: false; message: string } {
  const rawNo = typeof b.part === 'string' ? b.part.trim() : b.part === undefined ? '' : String(b.part);
  const rawCount = typeof b.parts === 'string' ? b.parts.trim() : b.parts === undefined ? '' : String(b.parts);
  if (!rawNo && !rawCount) return { ok: true, part: null };
  const bad = { ok: false as const, message: 'The part number of this packing list is not valid.' };
  if (!PART_RE.test(rawNo) || !PART_RE.test(rawCount)) return bad;
  const no = Number(rawNo);
  const count = Number(rawCount);
  if (count < 2 || count > MAX_SHEET_PARTS || no < 1 || no > count) return bad;
  return { ok: true, part: { no, count } };
}

function parseDayAndDos(b: { deliveryDate?: unknown; doIds?: unknown; part?: unknown; parts?: unknown }): DayAndDos {
  const deliveryDate = typeof b.deliveryDate === 'string' ? b.deliveryDate.trim() : '';
  if (!DATE_RE.test(deliveryDate) || Number.isNaN(Date.parse(`${deliveryDate}T00:00:00Z`))) {
    return { ok: false, message: 'The delivery date is not a valid date.' };
  }
  if (!Array.isArray(b.doIds)) return { ok: false, message: 'No delivery orders were given for this packing list.' };
  const doIds: string[] = [];
  for (const v of b.doIds) {
    const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!UUID_RE.test(id)) return { ok: false, message: 'One of the delivery orders on this packing list is not valid.' };
    if (!doIds.includes(id)) doIds.push(id);
  }
  if (doIds.length === 0) return { ok: false, message: 'No delivery orders were given for this packing list.' };
  if (doIds.length > LORRY_DAY_MAX_DOS) {
    return { ok: false, message: `A packing list QR can cover up to ${LORRY_DAY_MAX_DOS} delivery orders.` };
  }
  const part = parsePart(b);
  if (!part.ok) return part;
  return { ok: true, deliveryDate, doIds, part: part.part };
}

/** PURE. The request body, checked: a plate, a YYYY-MM-DD date, 1..60 distinct uuids
 *  in the order given (the sheet order). */
export function parseLorryDaySheet(raw: unknown):
  | { ok: true; sheet: LorryDaySheetInput }
  | { ok: false; message: string } {
  const b = (raw ?? {}) as { lorryPlate?: unknown; deliveryDate?: unknown; doIds?: unknown; part?: unknown; parts?: unknown };
  const lorryPlate = typeof b.lorryPlate === 'string' ? b.lorryPlate.trim() : '';
  if (!lorryPlate || lorryPlate.length > 40 || !normalizePlate(lorryPlate)) {
    return { ok: false, message: 'A lorry plate is needed to print this packing list QR.' };
  }
  const rest = parseDayAndDos(b);
  if (!rest.ok) return rest;
  return { ok: true, sheet: { lorryPlate, deliveryDate: rest.deliveryDate, doIds: rest.doIds, part: rest.part } };
}

/** PURE. The region sheet's request, checked like the lorry one: a region key (1..60
 *  characters), a YYYY-MM-DD date, 1..60 distinct uuids in sheet order. */
export function parseRegionDaySheet(raw: unknown):
  | { ok: true; sheet: RegionDaySheetInput }
  | { ok: false; message: string } {
  const b = (raw ?? {}) as { region?: unknown; deliveryDate?: unknown; doIds?: unknown; part?: unknown; parts?: unknown };
  const region = typeof b.region === 'string' ? b.region.trim() : '';
  if (!region || region.length > 60) {
    return { ok: false, message: 'A region is needed to print this packing list QR.' };
  }
  const rest = parseDayAndDos(b);
  if (!rest.ok) return rest;
  return { ok: true, sheet: { region, deliveryDate: rest.deliveryDate, doIds: rest.doIds, part: rest.part } };
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

export type MintedLorryDayToken =
  | { status: 'ok'; token: string }
  | { status: 'foreign'; doIds: string[] }
  | { status: 'read_failed' };

/** Which sheet a token belongs to: a lorry's (by plate) or a region's (by region key). */
export type PackingSheetKey = { kind: 'lorry'; lorryPlate: string } | { kind: 'region'; region: string };

/**
 * Create-or-reuse the token for one printed sheet. AUTHENTICATED CALLERS ONLY.
 * Every DO id must be a delivery order of `companyId`, or nothing is minted and the
 * missing / other-company ids are returned. The same company + sheet key + date + DO
 * set + part returns the existing live token, so a re-print carries the same QR.
 */
export async function mintPackingScanToken(
  sb: Db,
  companyId: number,
  key: PackingSheetKey,
  deliveryDate: string,
  doIds: string[],
  part: SheetPart | null,
  createdBy: string | null,
): Promise<MintedLorryDayToken> {
  const { data: own, error: ownErr } = await scopeToCompanyId(
    sb.from('delivery_orders').select('id').in('id', doIds),
    companyId,
  );
  if (ownErr) return { status: 'read_failed' };
  const mine = new Set((own as Array<{ id: string }>).map((r) => String(r.id).toLowerCase()));
  const foreign = doIds.filter((id) => !mine.has(id));
  if (foreign.length > 0) return { status: 'foreign', doIds: foreign };

  const sameDay = sb.from('packing_scan_sets').select('qr_token, do_ids, part_no, part_count').eq('delivery_date', deliveryDate);
  const sameSheet = key.kind === 'lorry'
    ? sameDay.eq('sheet_kind', 'lorry').eq('lorry_plate', key.lorryPlate)
    : sameDay.eq('sheet_kind', 'region').eq('region', key.region);
  const { data: existing, error: exErr } = await scopeToCompanyId(sameSheet.is('qr_revoked_at', null), companyId);
  if (exErr) return { status: 'read_failed' };
  const reuse = (existing as Array<{ qr_token: string; do_ids: string[] | null; part_no: number | null; part_count: number | null }>)
    .find((r) => sameSet((r.do_ids ?? []).map((x) => String(x).toLowerCase()), doIds)
      && (r.part_no ?? null) === (part?.no ?? null) && (r.part_count ?? null) === (part?.count ?? null));
  if (reuse) return { status: 'ok', token: reuse.qr_token };

  const token = newDoScanToken();
  const { error: insErr } = await sb.from('packing_scan_sets').insert({
    company_id: companyId,
    sheet_kind: key.kind,
    lorry_plate: key.kind === 'lorry' ? key.lorryPlate : null,
    region: key.kind === 'region' ? key.region : null,
    delivery_date: deliveryDate,
    do_ids: doIds,
    qr_token: token,
    part_no: part?.no ?? null,
    part_count: part?.count ?? null,
    created_by: createdBy,
  });
  if (insErr) return { status: 'read_failed' };
  return { status: 'ok', token };
}

/** The lorry sheet's mint (see mintPackingScanToken). */
export function mintLorryDayScanToken(
  sb: Db,
  companyId: number,
  sheet: LorryDaySheetInput,
  createdBy: string | null,
): Promise<MintedLorryDayToken> {
  return mintPackingScanToken(sb, companyId, { kind: 'lorry', lorryPlate: sheet.lorryPlate }, sheet.deliveryDate, sheet.doIds, sheet.part, createdBy);
}

/** The region sheet's mint (see mintPackingScanToken). */
export function mintRegionDayScanToken(
  sb: Db,
  companyId: number,
  sheet: RegionDaySheetInput,
  createdBy: string | null,
): Promise<MintedLorryDayToken> {
  return mintPackingScanToken(sb, companyId, { kind: 'region', region: sheet.region }, sheet.deliveryDate, sheet.doIds, sheet.part, createdBy);
}

/** The printed sheet a token resolved to. `companyId` is the row's own. */
export type ResolvedLorryDayScan = {
  id: string;
  companyId: number;
  sheetKind: 'lorry' | 'region';
  lorryPlate: string | null;
  region: string | null;
  deliveryDate: string;
  doIds: string[];
  preparedAt: string | null;
  loadedAt: string | null;
  part: SheetPart | null;
};

/** PURE. "Lorry VJK 8821", "Region KL · Part 1 of 2": how the scan page names a sheet. */
export function packingSheetTitle(set: Pick<ResolvedLorryDayScan, 'sheetKind' | 'lorryPlate' | 'region' | 'part'>): string {
  const base = set.sheetKind === 'region' ? `Region ${set.region ?? ''}` : `Lorry ${set.lorryPlate ?? ''}`;
  return set.part ? `${base} · Part ${set.part.no} of ${set.part.count}` : base;
}

export type LorryDayMember = TripScanMember & { movedReason: string | null };

export const LORRY_DAY_MOVED_REASON =
  'Moved to another lorry since this sheet was printed, so it was not touched. Check with the office.';
export const LORRY_DAY_UNASSIGNED_REASON =
  'Taken off this lorry since this sheet was printed, so it was not touched. Check with the office.';
export const LORRY_DAY_MISSING_REASON =
  'This delivery order is no longer in the system, so it was not touched. Call the office.';

/** PURE. Why a printed DO must not be loaded from this sheet any more, or null.
 *  The current plate is the crew plate, else the DO's typed vehicle. */
export function lorryDayMovedReason(
  printedPlate: string,
  crewPlate: string | null,
  vehicle: string | null,
): string | null {
  const now = normalizePlate(crewPlate) || normalizePlate(vehicle);
  if (!now) return LORRY_DAY_UNASSIGNED_REASON;
  return now === normalizePlate(printedPlate) ? null : LORRY_DAY_MOVED_REASON;
}

export type LorryDayMembersResult =
  | { status: 'ok'; members: LorryDayMember[] }
  | { status: 'read_failed' };

/** The printed DOs in sheet order, each with its current status and, on a lorry sheet,
 *  whether it has left this lorry. A region sheet ignores lorries (owner 2026-11-28),
 *  so it reads no crew and reports nothing as MOVED. Every read is scoped to the sheet's company. */
export async function loadLorryDayMembers(
  sb: Db,
  sheet: ResolvedLorryDayScan,
): Promise<LorryDayMembersResult> {
  const { data: doData, error: doErr } = await scopeToCompanyId(
    sb.from('delivery_orders').select('id, do_number, debtor_name, status, on_hold, vehicle').in('id', sheet.doIds),
    sheet.companyId,
  );
  if (doErr) return { status: 'read_failed' };
  const printedPlate = sheet.sheetKind === 'lorry' ? sheet.lorryPlate : null;
  let crewData: unknown[] = [];
  if (printedPlate !== null) {
    const crew = await scopeToCompanyId(
      sb.from('delivery_order_crew').select('do_id, lorry_plate').in('do_id', sheet.doIds),
      sheet.companyId,
    );
    if (crew.error) return { status: 'read_failed' };
    crewData = crew.data as unknown[];
  }

  const byId = new Map<string, {
    do_number: string | null; debtor_name: string | null; status: string | null;
    on_hold: boolean | null; vehicle: string | null;
  }>();
  for (const r of doData as Array<{ id: string; do_number: string | null; debtor_name: string | null; status: string | null; on_hold: boolean | null; vehicle: string | null }>) {
    byId.set(String(r.id).toLowerCase(), r);
  }
  const plateOf = new Map<string, string | null>();
  for (const r of crewData as Array<{ do_id: string; lorry_plate: string | null }>) {
    plateOf.set(String(r.do_id).toLowerCase(), r.lorry_plate ?? null);
  }

  const members = sheet.doIds.map((rawId, i): LorryDayMember => {
    const doId = rawId.toLowerCase();
    const row = byId.get(doId);
    if (!row) {
      return {
        stopNo: i + 1, doId, doNumber: null, customerName: null, status: null, onHold: null,
        foreign: false, movedReason: LORRY_DAY_MISSING_REASON,
      };
    }
    return {
      stopNo: i + 1,
      doId,
      doNumber: row.do_number ?? null,
      customerName: row.debtor_name ?? null,
      status: row.status ?? null,
      onHold: row.on_hold ?? null,
      foreign: false,
      movedReason: printedPlate === null
        ? null
        : lorryDayMovedReason(printedPlate, plateOf.get(doId) ?? null, row.vehicle ?? null),
    };
  });
  return { status: 'ok', members };
}
