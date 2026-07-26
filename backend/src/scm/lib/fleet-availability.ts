// ---------------------------------------------------------------------------
// fleet-availability.ts — Fleet Module A2: load a depot's lorries WITH their
// Module-B dispatch status folded in, so the A2 assigner never puts a delivery
// on a lorry the maintenance module has grounded.
//
// This is the vehicle-availability half of A3. It reuses Module B's PURE state
// machine verbatim (services/fleet-status.ts: deriveVehicleStatus + canDispatch)
// over the same signals the maintenance dashboard reads — compliance docs (vault
// + the flat scm.lorries columns), an active maintenance WINDOW, service-due
// mileage/date, active breakdown cases, and open work orders. A lorry that
// derives to BREAKDOWN / COMPLIANCE_BLOCKED / OUT_OF_SERVICE / a maintenance
// window (or any other non-dispatchable status) comes back with
// `dispatchable: false`, and the assigner excludes it.
//
// It is a thin DB loader — the reasoning it relies on is the unit-tested pure
// core. It writes NOTHING.
// ---------------------------------------------------------------------------

import {
  deriveVehicleStatus,
  canDispatch,
  currentDocsByType,
  VEHICLE_STATUS_LABELS,
  type ComplianceDocType,
  type ComplianceDocInput,
  type PuspakomResult,
  type MaintenancePlanInput,
  type VehicleStatus,
} from '../../services/fleet-status';
import type { CapacityLayer } from './capacity-pack';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}
function normPlate(p: string | null | undefined): string {
  return String(p ?? '').replace(/\s+/g, '').toUpperCase();
}
const CAP_LAYERS: ReadonlySet<string> = new Set(['SETS', 'REVENUE', 'BOTH']);
const FLAT_COL: Partial<Record<ComplianceDocType, 'road_tax_expiry' | 'insurance_expiry' | 'puspakom_expiry'>> = {
  ROAD_TAX: 'road_tax_expiry',
  INSURANCE: 'insurance_expiry',
  PUSPAKOM: 'puspakom_expiry',
};

export interface AvailableLorry {
  id: string;
  plate: string;
  warehouseId: string | null;
  status: VehicleStatus;
  statusLabel: string;
  dispatchable: boolean;
  maxSets: number | null;
  maxRevenueCenti: number | null;
  layer: CapacityLayer;
  /** The lorry's regular driver, matched by plate (drivers.vehicle). */
  driverId: string | null;
  driverName: string | null;
}

type Row = Record<string, unknown>;
function dual<T = unknown>(r: Row, camel: string, snake: string): T | undefined {
  return (r[camel] ?? r[snake]) as T | undefined;
}

/**
 * Load the depot's active, in-house lorries with a derived Module-B dispatch
 * status. `depotWarehouseId` null → every depot's fleet. `today` is MYT date.
 *
 * The `sb` client is the scm-scoped PostgREST client (c.get('supabase')). A
 * missing maintenance table (fresh env) degrades that signal to "no rows", never
 * a throw — availability then reflects only the signals that ARE present, which
 * is the safe direction (a lorry is dispatchable unless something grounds it).
 */
export async function loadAvailableLorries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  opts: { depotWarehouseId?: string | null; today: string },
): Promise<AvailableLorry[]> {
  const { today } = opts;

  let lq = sb.from('lorries')
    .select('id, plate, warehouse_id, active, is_internal, road_tax_expiry, insurance_expiry, puspakom_expiry, max_sets, max_revenue_centi, capacity_layer')
    .eq('active', true)
    .eq('is_internal', true)
    .order('plate');
  if (opts.depotWarehouseId) lq = lq.eq('warehouse_id', opts.depotWarehouseId);
  const { data: lorryRows } = await lq;
  const lorries = (lorryRows ?? []) as Row[];
  if (lorries.length === 0) return [];

  const ids = lorries.map((l) => String(l.id));

  // Module-B signals. Each read is defensive: a table absent on a fresh env just
  // yields no rows for that signal (Promise.allSettled — never a hard failure).
  const [driversR, vaultR, maintR, svcR, plansR, mileageR, breakdownR] = await Promise.allSettled([
    sb.from('drivers').select('vehicle, id, name').eq('active', true),
    sb.from('lorry_compliance_documents').select('lorry_id, doc_type, expiry_date, issue_date, result').in('lorry_id', ids),
    sb.from('lorry_maintenance').select('lorry_id, reason').lte('unavailable_from', today).gte('unavailable_to', today).in('lorry_id', ids),
    sb.from('lorry_service_records').select('lorry_id, service_date, odometer_km, next_service_km, next_service_date').in('lorry_id', ids).order('service_date', { ascending: false }),
    sb.from('lorry_maintenance_plans').select('lorry_id, component, interval_km, interval_months, last_done_date, last_done_km, active').eq('active', true).in('lorry_id', ids),
    sb.from('lorry_mileage_readings').select('lorry_id, odometer_km, reading_date').in('lorry_id', ids).order('reading_date', { ascending: false }),
    sb.from('lorry_breakdown_cases').select('lorry_id, severity, status').neq('status', 'RESOLVED').in('lorry_id', ids),
  ] as const);
  const rows = (r: PromiseSettledResult<{ data?: Row[] | null }>): Row[] =>
    r.status === 'fulfilled' ? ((r.value?.data ?? []) as Row[]) : [];

  const driverByPlate = new Map<string, { id: string; name: string }>();
  for (const d of rows(driversR)) {
    const key = normPlate(d.vehicle as string | null);
    if (key && !driverByPlate.has(key)) driverByPlate.set(key, { id: String(d.id), name: String(d.name ?? '') });
  }

  const vaultByLorry = new Map<string, Row[]>();
  for (const v of rows(vaultR)) {
    const lid = String(dual(v, 'lorryId', 'lorry_id'));
    const arr = vaultByLorry.get(lid) ?? [];
    arr.push(v);
    vaultByLorry.set(lid, arr);
  }
  const oosByLorry = new Set<string>();
  for (const m of rows(maintR)) oosByLorry.add(String(dual(m, 'lorryId', 'lorry_id')));

  const latestSvc = new Map<string, { nextKm: number | null; nextDate: string | null; odo: number | null }>();
  for (const s of rows(svcR)) {
    const lid = String(dual(s, 'lorryId', 'lorry_id'));
    if (!latestSvc.has(lid)) latestSvc.set(lid, {
      nextKm: (dual<number>(s, 'nextServiceKm', 'next_service_km') ?? null),
      nextDate: iso(dual(s, 'nextServiceDate', 'next_service_date')),
      odo: (dual<number>(s, 'odometerKm', 'odometer_km') ?? null),
    });
  }
  const plansByLorry = new Map<string, MaintenancePlanInput[]>();
  for (const p of rows(plansR)) {
    const lid = String(dual(p, 'lorryId', 'lorry_id'));
    const arr = plansByLorry.get(lid) ?? [];
    plansByLorry.set(lid, arr);
    arr.push({
      component: String(dual(p, 'component', 'component') ?? ''),
      intervalKm: (dual<number>(p, 'intervalKm', 'interval_km') ?? null),
      intervalMonths: (dual<number>(p, 'intervalMonths', 'interval_months') ?? null),
      lastDoneDate: iso(dual(p, 'lastDoneDate', 'last_done_date')),
      lastDoneKm: (dual<number>(p, 'lastDoneKm', 'last_done_km') ?? null),
      active: (dual<boolean>(p, 'active', 'active') ?? true),
    });
  }
  const latestMileage = new Map<string, number | null>();
  for (const m of rows(mileageR)) {
    const lid = String(dual(m, 'lorryId', 'lorry_id'));
    if (!latestMileage.has(lid)) latestMileage.set(lid, (dual<number>(m, 'odometerKm', 'odometer_km') ?? null));
  }
  const breakdownByLorry = new Map<string, boolean>();
  for (const b of rows(breakdownR)) {
    const lid = String(dual(b, 'lorryId', 'lorry_id'));
    const severity = String(dual(b, 'severity', 'severity') ?? '');
    const status = String(dual(b, 'status', 'status') ?? '');
    if (severity === 'CRITICAL' && status !== 'RESOLVED') breakdownByLorry.set(lid, true);
  }

  return lorries.map((l): AvailableLorry => {
    const id = String(l.id);
    const plate = String(l.plate ?? '');
    // Current compliance doc per type: latest-expiring vault row, else the flat
    // scm.lorries column (existing lorries with no vault rows still resolve).
    const vaultRows = vaultByLorry.get(id) ?? [];
    const currentVault = currentDocsByType(vaultRows.map((d) => ({
      docType: String(dual(d, 'docType', 'doc_type')) as ComplianceDocType,
      expiryDate: iso(dual(d, 'expiryDate', 'expiry_date')),
      issueDate: iso(dual(d, 'issueDate', 'issue_date')),
    })));
    const statusDocs: ComplianceDocInput[] = [];
    for (const type of ['PUSPAKOM', 'ROAD_TAX', 'INSURANCE', 'APAD', 'CROSS_BORDER'] as ComplianceDocType[]) {
      const picked = currentVault.get(type);
      if (picked) {
        const full = vaultRows.find((d) =>
          String(dual(d, 'docType', 'doc_type')) === type &&
          iso(dual(d, 'expiryDate', 'expiry_date')) === picked.expiryDate);
        statusDocs.push({ docType: type, expiryDate: picked.expiryDate, result: (full ? (dual(full, 'result', 'result') as PuspakomResult | null) : null) });
        continue;
      }
      const col = FLAT_COL[type];
      const flat = col ? iso(l[col]) : null;
      if (flat) statusDocs.push({ docType: type, expiryDate: flat, result: null });
    }

    const svc = latestSvc.get(id);
    const currentMileageKm = latestMileage.get(id) ?? svc?.odo ?? null;
    const status = deriveVehicleStatus({
      today,
      outOfService: oosByLorry.has(id),
      currentDocs: statusDocs,
      currentMileageKm,
      nextServiceKm: svc?.nextKm ?? null,
      nextServiceDate: svc?.nextDate ?? null,
      plans: plansByLorry.get(id) ?? [],
      breakdownActive: breakdownByLorry.get(id) ?? false,
    });

    const layerRaw = String(dual(l, 'capacityLayer', 'capacity_layer') ?? 'SETS').toUpperCase();
    const layer: CapacityLayer = (CAP_LAYERS.has(layerRaw) ? layerRaw : 'SETS') as CapacityLayer;
    const ms = dual<number>(l, 'maxSets', 'max_sets');
    const mr = dual<number>(l, 'maxRevenueCenti', 'max_revenue_centi');
    const paired = driverByPlate.get(normPlate(plate)) ?? null;

    return {
      id,
      plate,
      warehouseId: (dual<string>(l, 'warehouseId', 'warehouse_id') ?? null) as string | null,
      status,
      statusLabel: VEHICLE_STATUS_LABELS[status],
      dispatchable: canDispatch(status),
      maxSets: ms == null ? null : Number(ms),
      maxRevenueCenti: mr == null ? null : Number(mr),
      layer,
      driverId: paired?.id ?? null,
      driverName: paired?.name ?? null,
    };
  });
}
