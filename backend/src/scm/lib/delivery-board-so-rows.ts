import { deriveBranding } from './so-display-branding';
import { summariseReadiness } from './so-readiness';
import { readinessRowFields } from './so-readiness-row';
import { deriveArrangementStage } from './arrangement-stage';
import { effectiveSoDelivery } from '../shared';
import { soExemptionExpiryOf } from './so-exemption-expiry';
import { computeReleaseGate } from '../../services/agents/release-gate';
import { pickDisplayCrew } from '../routes/delivery-planning-fields';
import { stateToRegionsFromConfig, FALLBACK_DEFAULT_REGION, type Region, type RegionConfig } from './delivery-board-regions';
import type { SoBoardMaps } from './delivery-board-maps';

export type SoHeaderRow = {
  doc_no: string | null; debtor_code: string | null; debtor_name: string | null;
  company_id: number | null;
  phone: string | null; branding: string | null; status: string | null; delivery_state: string | null;
  agent: string | null; salesperson_id: string | null; salespersonId?: string | null; venue: string | null;
  customer_state: string | null; customer_country: string | null;
  customer_delivery_date: string | null; sales_exemption_expiry: string | null; salesExemptionExpiry?: string | null; processing_date: string | null;
  so_date: string | null; address1: string | null; address2: string | null;
  postcode: string | null; building_type: string | null;
  local_total_sen: number | null; balance_sen: number | null;
  amend_date_from_customer: string | null; amended_delivery_date: string | null;
  amendDateFromCustomer?: string | null; amendedDeliveryDate?: string | null;
  amend_reason: string | null; amendReason?: string | null; amend_reason_from_customer: string | null; amendReasonFromCustomer?: string | null;
  possession_date: string | null; house_type: string | null;
  replacement_disposal: string | null; referral: string | null; ref: string | null; customer_so_no: string | null;
  possessionDate?: string | null; houseType?: string | null; replacementDisposal?: string | null;
  // HC delivery MESSAGE status (the follow-up workflow status, owner 2026-09-22).
  delivery_message_status: string | null; deliveryMessageStatus?: string | null;
  // Delivery-planning admin free-text fields (owner 2026-09-22). dual-read.
  disposal_request: string | null; disposalRequest?: string | null;
  dp_remark: string | null; dpRemark?: string | null;
};

type DeliveryState = 'PENDING_DELIVERY' | 'PENDING_SCHEDULE' | 'OVERDUE' | 'DELIVERED';

export type SoRowCtx = {
  today: string;
  regionCfg: RegionConfig;
  codeMap: Map<number, string>;
  whCode: Map<string, string>;
  whName: Map<string, string>;
  deliveryStates: readonly string[];
  deriveState: (input: {
    storedOverride: string | null | undefined; status: string | null | undefined;
    readiness: { isShipReady: boolean }; delivered: number; remaining: number;
    effectiveDD: string | null | undefined; amendedDD: string | null | undefined; salesExemptionExpiry: string | null; today: string;
  }) => DeliveryState;
  daysLeft: (fromISO: string, toISO: string | null | undefined) => number | null;
};

export function assembleSoOrders(soRows: SoHeaderRow[], m: SoBoardMaps, x: SoRowCtx) {
  return soRows.map((r) => {
    const docNo = String(r.doc_no ?? '');
    const hasRep = m.repCat.has(docNo);
    const fCat = (hasRep ? m.repCat.get(docNo) : m.firstCat.get(docNo)) ?? null;
    let fBranding = (hasRep ? m.repBranding.get(docNo) : m.firstBranding.get(docNo)) ?? null;
    if (fCat === 'MATTRESS' && (!fBranding || !fBranding.trim())) {
      const code = hasRep ? m.repCode.get(docNo) : m.firstItemCode.get(docNo);
      fBranding = (code && m.productBranding.get(code)) || fBranding;
    }
    /* Company comes PER ROW, not from the caller: this board is a SHARED queue,
       so labelling a Houzs order "2990 Sofa" because a 2990 user opened it is a
       WRONG label, not a missing one. The old `|| null` is gone — the rule
       cannot return blank now (owner 2026-08-17), so it could only restore the
       empty state. See scm/shared/so-branding-label.ts. */
    const branding = deriveBranding(fCat, fBranding, x.codeMap.get(Number(r.company_id)) ?? null);
    const readiness = summariseReadiness(m.linesByDoc.get(docNo) ?? []);
    const delivered = m.deliveredByDoc.get(docNo) ?? 0;
    const remaining = m.remainingByDoc.get(docNo) ?? 0;
    const status = String(r.status ?? '').toUpperCase();
    const customerDD = r.customer_delivery_date ?? null;
    const procDate = r.processing_date ?? null;
    const amendDateFromCustomer = r.amendDateFromCustomer ?? r.amend_date_from_customer ?? null;
    const amendedDD = r.amendedDeliveryDate ?? r.amended_delivery_date ?? null;
    const effectiveDD = effectiveSoDelivery(r);

    const readyToShip = readiness.isShipReady;

    const stored = r.delivery_state ?? null;
    const frozenExpiry = r.salesExemptionExpiry ?? r.sales_exemption_expiry ?? null;
    const salesExemptionExpiry = soExemptionExpiryOf({
      sales_exemption_expiry: frozenExpiry, ac_sales_exemption_expiry: m.acExpiryByDoc.get(docNo) ?? null, customer_delivery_date: customerDD,
    });
    const state: DeliveryState = x.deriveState({
      storedOverride: stored, status, readiness, delivered, remaining, effectiveDD, amendedDD, salesExemptionExpiry, today: x.today,
    });

    const stateRegions = stateToRegionsFromConfig(x.regionCfg, r.customer_state, r.customer_country);
    const primaryRegion = stateRegions[0] ?? FALLBACK_DEFAULT_REGION;
    const regionSet = new Set<Region>(stateRegions);

    const dos = m.doByDoc.get(docNo) ?? [];
    const crew = pickDisplayCrew(dos.map((d) => d.id), (id) => m.crewByDo.get(id) ?? m.typedCrewByDo.get(id) ?? null, (cr) => !!cr.driver_1_name);
    const warehouseIds = [...(m.warehousesByDoc.get(docNo) ?? new Set<string>())];
    const primaryWh = warehouseIds[0] ?? null;

    return {
      row_type: 'so' as 'so' | 'assr' | 'dp' | 'project',
      ref: null as string | null,
      so_ref: ((r.ref as string | null) || (r.customer_so_no as string | null)) ?? null,
      related_do_nos: null as string[] | null,
      job_kind: null as 'customer_pickup' | 'delivery' | 'inspection' | null,
      dp_job_type: null as string | null,
      dp_from_name: null as string | null,
      dp_no: m.dpNoByDoc.get(docNo) ?? null,
      assr_id: null as number | null,
      so_doc_no: docNo,
      debtor_code: r.debtor_code ?? null,
      debtor_name: r.debtor_name ?? null,
      phone: r.phone ?? null,
      agent: r.agent ?? null, salesperson_id: r.salespersonId ?? r.salesperson_id ?? null, venue: r.venue ?? null,
      branding: branding as string | null,
      status,
      delivery_state: state,
      delivery_state_override: stored && x.deliveryStates.includes(stored) ? stored : null,
      balance_sen: Number(r.balance_sen ?? 0),
      balance_sen_live: m.liveBalanceByDoc.has(docNo) ? m.liveBalanceByDoc.get(docNo)! : null,
      local_total_sen: Number(r.local_total_sen ?? 0),
      release_gate: (() => {
        const total = Number(r.local_total_sen ?? 0);
        const live = m.liveBalanceByDoc.has(docNo) ? m.liveBalanceByDoc.get(docNo)! : null;
        const bal = live != null ? live : Number(r.balance_sen ?? 0);
        const g = computeReleaseGate({
          totalSen: total,
          paidSen: Math.max(0, total - bal),
          dataQuality: live != null ? 'GREEN' : 'AMBER',
        });
        return {
          decision: g.decision,
          remaining_sen: g.remainingSen,
          collect_on_delivery_sen: g.collectOnDeliverySen,
          reason: g.reason,
        };
      })(),
      so_date: r.so_date ?? null,
      // ORIGINAL date (never overwritten); sales_exemption_expiry = frozen original, shown in the SXE column via soExemptionExpiryOf (owner 2026-10-22).
      customer_delivery_date: customerDD, sales_exemption_expiry: frozenExpiry,
      amend_date_from_customer: amendDateFromCustomer,
      amended_delivery_date: amendedDD,
      amend_reason: r.amendReason ?? r.amend_reason ?? null, amend_reason_from_customer: r.amendReasonFromCustomer ?? r.amend_reason_from_customer ?? null,
      effective_delivery_date: effectiveDD,
      processing_date: procDate,
      po_locked: m.poLockedDocs.has(docNo),
      days_left: x.daysLeft(x.today, effectiveDD),
      address: [r.address1, r.address2].filter(Boolean).join(', ') || null,
      postcode: r.postcode ?? null,
      building_type: r.building_type ?? null,
      possession_date: r.possessionDate ?? r.possession_date ?? null,
      house_type: r.houseType ?? r.house_type ?? null,
      replacement_disposal: r.replacementDisposal ?? r.replacement_disposal ?? null,
      referral: r.referral ?? null,
      delivery_message_status: r.deliveryMessageStatus ?? r.delivery_message_status ?? null,
      disposal_request: r.disposalRequest ?? r.disposal_request ?? null,
      dp_remark: r.dpRemark ?? r.dp_remark ?? null,
      remark_locked: false,
      time_range: m.doExecByDoc.get(docNo)?.time_range ?? null,
      time_confirmed: m.doExecByDoc.get(docNo)?.time_confirmed ?? null,
      arrival_at: m.doExecByDoc.get(docNo)?.arrival_at ?? null,
      departure_at: m.doExecByDoc.get(docNo)?.departure_at ?? null,
      shipout_date: m.doExecByDoc.get(docNo)?.shipout_date ?? null,
      customer_delivered_date: m.doExecByDoc.get(docNo)?.customer_delivered_date ?? null,
      eta_arriving_port: m.doExecByDoc.get(docNo)?.eta_arriving_port ?? null,
      delivery_substatus: m.doExecByDoc.get(docNo)?.delivery_substatus ?? null,
      arrives_em_warehouse_date: m.doExecByDoc.get(docNo)?.arrives_em_warehouse_date ?? null,
      // EM cross-border transport status (owner 2026-09-23), from the latest DO.
      em_delivery_status: m.doExecByDoc.get(docNo)?.em_delivery_status ?? null,
      consignment_no: m.doExecByDoc.get(docNo)?.consignment_no ?? null,
      vessel_voyage: m.doExecByDoc.get(docNo)?.vessel_voyage ?? null,
      etd_port_klang: m.doExecByDoc.get(docNo)?.etd_port_klang ?? null,
      bs_delivery_date: m.doExecByDoc.get(docNo)?.bs_delivery_date ?? null,
      esb_remarks: m.doExecByDoc.get(docNo)?.esb_remarks ?? null,
      bs_remarks: m.doExecByDoc.get(docNo)?.bs_remarks ?? null,
      ctn: m.doExecByDoc.get(docNo)?.ctn ?? null,
      em_delivered_date: m.doExecByDoc.get(docNo)?.em_delivered_date ?? null,
      do_date: m.doExecByDoc.get(docNo)?.do_date ?? null,
      delivered_at: m.doExecByDoc.get(docNo)?.delivered_at ?? null,
      pod_r2_key: m.doExecByDoc.get(docNo)?.pod_r2_key ?? null,
      pod_lat: m.doExecByDoc.get(docNo)?.pod_lat ?? null,
      has_pod: m.doExecByDoc.get(docNo)?.has_pod ?? false,
      ...readinessRowFields(readiness),
      company_code: x.codeMap.get(Number(r.company_id)) ?? null,
      region: primaryRegion,
      regions: [...regionSet],
      warehouse_id: primaryWh as string | null,
      warehouse_code: primaryWh ? (x.whCode.get(primaryWh) ?? null) : null,
      warehouse_name: primaryWh ? (x.whName.get(primaryWh) ?? null) : null,
      customer_state: r.customer_state ?? null, customer_country: r.customer_country ?? null,
      delivered_qty: delivered,
      remaining_qty: remaining,
      crew,
      delivery_orders: dos.map((d) => ({ id: d.id, do_number: d.doNumber, status: d.status })),
      trip_id: m.tripByDoc.get(docNo)?.id ?? null,
      trip_no: m.tripByDoc.get(docNo)?.trip_no ?? null,
      trip_date: m.tripByDoc.get(docNo)?.trip_date ?? null,
      /* Time-of-run keys (owner 2026-08-08: within the same date/state/postcode
         group the Time queues also order by TIME) — the stop's sequence and
         ETA offset on its live trip; null off-trip. */
      trip_stop_no: m.tripByDoc.get(docNo)?.stop_no ?? null,
      trip_eta_offset_s: m.tripByDoc.get(docNo)?.eta_offset_s ?? null,
      arrangement_stage: deriveArrangementStage({
        deliveryState: state,
        dateConfirmed: amendedDD != null,
        onActiveTrip: m.tripByDoc.has(docNo),
      }),
    };
  });
}

export type SoBoardRow = ReturnType<typeof assembleSoOrders>[number];
