// ----------------------------------------------------------------------------
// LorryRecord — one lorry's FULL record, on its own page.
//
// WHY IT EXISTS. Owner, 2026-08-02: "这个 Fleet Health 不可能只是在右边展示...
// 它应该要支持展开... 要不然界面会显得非常乱. 例如 Compliance 这些资料，就不需要在
// 刚点开的时候直接显示在右边. 包括我的 New Work Order 和 Import Work Shop Document
// 都不需要在这边."
//
// The Fleet Health drawer had grown to carry everything a lorry has ever had —
// breakdowns, work orders, tyres, plans, mileage history and a five-kind
// compliance vault with per-document renewal history and file attachments — in
// a side panel you scroll for a page and a half. The drawer's real question is
// "can I use this lorry today"; everything else belongs here.
//
// THE SECTIONS ARE THE SAME COMPONENTS, IMPORTED, not re-implemented. They were
// written and exercised in FleetHealth and moving them by hand is how one copy
// quietly loses a fix. Only the drawer got smaller; nothing here is new code
// pretending to be the old behaviour.
//
// Route /fleet-health/:lorryId, gated exactly as /fleet-health is (fleet.read).
// ----------------------------------------------------------------------------

import { useParams, useSearchParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { useLorries } from "../vendor/scm/lib/lorries-queries";
import { fmtDate, fmtSen, todayMY } from "../vendor/shared/format";
import { CapacityCard, PurchaseCard } from "./fleet/LorryVehicle";
import { LorryTodayRoute } from "./fleet/LorryTodayRoute";
import { RepairSpend, repairSpendOf } from "./fleet/RepairSpend";
import { LorryCompliance } from "./fleet/LorryCompliance";
import { EMPTY, FleetCard, KpiTile, PlateBadge, TONE_DOT } from "./fleet/FleetUi";
import { OffRoadPanel } from "./fleet/OffRoadPanel";
import { lorryBox } from "./fleet/fleetHealthModel";
import { Lorry3D } from "./scm-v2/fleet/Lorry3D";
import {
  PlansSection, MileageSection, BreakdownSection, WorkOrdersSection,
  ComponentsSection, MissingComplianceNote, Pill, boxLabel, fmtDays,
  DOC_TYPES, DOC_LABEL, STATUS_TONE,
  type VehicleDetailPayload, type DocType, type Tone,
} from "./FleetHealth";

const Section = FleetCard;

const Breadcrumb = ({ plate }: { plate: string }) => (
  <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
    <Link to="/fleet-health" className="inline-flex min-h-9 items-center gap-1 font-semibold text-primary hover:underline">
      <ChevronLeft size={14} strokeWidth={2.4} /> Fleet Health
    </Link>
    <span className="text-ink-muted/70">/</span>
    <span className="text-ink-muted">{plate}</span>
  </nav>
);

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "repairs", label: "Repairs" },
  { id: "maintenance", label: "Maintenance" },
  { id: "compliance", label: "Compliance" },
  { id: "vehicle", label: "Vehicle" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** The document that runs out first. */
export function nextRenewal(compliance: VehicleDetailPayload["compliance"] | undefined): { type: DocType; date: string; days: number; tone: Tone } | null {
  const left = DOC_TYPES.flatMap((type) => {
    const g = compliance?.[type];
    const d = g?.history.find((x) => x.id === g.currentId);
    return d?.expiryDate && d.daysRemaining != null ? [{ type, date: d.expiryDate, days: d.daysRemaining, tone: d.tone }] : [];
  });
  return left.sort((a, b) => a.days - b.days)[0] ?? null;
}

type Attention = { text: string; tag: string; tone: Tone; tab: TabId };

/** What to do about this lorry, worst first, each opening the tab that fixes it. */
export function needsAttention(
  v: { mileageKm: number | null },
  planCount: number,
  openBreakdowns: ReadonlyArray<{ caseNo?: string | null; faultType: string | null; stillDrivable: boolean; status: string }>,
  openWorkOrders: ReadonlyArray<{ woNo?: string | null; problem: string | null; statusLabel: string }>,
  compliance: VehicleDetailPayload["compliance"] | undefined,
): Attention[] {
  const out: Attention[] = openBreakdowns.map((b) => ({
    text: `${b.caseNo ?? "Breakdown"} ${b.faultType ?? ""}`.trim(), tag: b.stillDrivable ? "Still drivable" : "Not drivable", tone: b.stillDrivable ? "warn" : "crit", tab: "repairs",
  }));
  for (const w of openWorkOrders) out.push({ text: `${w.woNo ?? "Work order"} ${w.problem ?? ""}`.trim(), tag: w.statusLabel, tone: "warn", tab: "repairs" });
  for (const type of DOC_TYPES) {
    const g = compliance?.[type];
    const d = g?.history.find((x) => x.id === g.currentId);
    if (d && d.tone !== "ok" && d.daysRemaining != null) out.push({ text: DOC_LABEL[type], tag: fmtDays(d.daysRemaining), tone: d.tone, tab: "compliance" });
  }
  if (v.mileageKm == null) out.push({ text: "No mileage reading", tag: "Record one", tone: "warn", tab: "maintenance" });
  if (planCount === 0) out.push({ text: "No service plan on this lorry", tag: "Add one", tone: "info", tab: "maintenance" });
  return out;
}

export function LorryRecord() {
  const { lorryId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.find((t) => t.id === params.get("tab"))?.id ?? "overview";

  const path = `/api/fleet-maintenance/vehicles/${encodeURIComponent(lorryId)}`;
  const detail = useQuery<VehicleDetailPayload>(path, () => api.get(path), [lorryId]);
  const refresh = () => detail.reload();

  const v = detail.data?.vehicle;
  const compliance = detail.data?.compliance;
  // The lorry master row: the vehicle-details editor writes it (PATCH /lorries/:id).
  const lorries = useLorries({ includeInactive: true, fleet: "all" });
  const lorryRow = (lorries.data ?? []).find((l) => l.id === lorryId) ?? null;

  if (detail.loading && !v) return <div className="space-y-4"><ListSkeleton /></div>;
  if (!v) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb plate="Not found" />
        <Section title="Lorry not found">
          <p className="text-[13px] text-ink-muted">{detail.error ? `Could not load this lorry: ${detail.error}` : "This lorry is not on file, or you cannot see it."}</p>
        </Section>
      </div>
    );
  }

  const box = boxLabel(v);

  /* Owner, 2026-10-15: Fleet Health is the in-house fleet's record. An outsourced
     lorry is the 3PL's to maintain — it needs only its delivery capacity, which
     is set on Coverage & Fleet. */
  if (v.isInternal === false) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb plate={v.plate} />
        <div className="flex items-center gap-2.5"><PlateBadge plate={v.plate} size="lg" /><Pill tone="neutral">Outsourced lorry</Pill></div>
        <p className="rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-ink-secondary">
          Fleet Health keeps in-house lorries only. An outsourced lorry needs no compliance, vehicle,
          repair or service record here; its delivery capacity is set on{" "}
          <Link to="/scm/fleet" className="text-primary hover:underline">Coverage &amp; Fleet</Link>.
        </p>
      </div>
    );
  }

  const breakdowns = detail.data?.breakdowns ?? [];
  const workOrders = detail.data?.workOrders ?? [];
  const today = todayMY();
  const openBreakdowns = breakdowns.filter((b) => b.status !== "RESOLVED");
  const openWorkOrders = workOrders.filter((w) => w.open);
  const next = nextRenewal(compliance);
  const spend = repairSpendOf(workOrders, today);
  const attention = needsAttention(v, detail.data?.plans.length ?? 0, openBreakdowns, openWorkOrders, compliance);
  const openTab = (id: TabId) => setParams((p) => { p.set("tab", id); return p; }, { replace: true });

  const oos = v.outOfService;
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb plate={v.plate} />

      <section className="flex flex-wrap items-stretch gap-5 rounded-2xl border border-border bg-surface p-3.5 sm:p-[18px]">
        <div className="min-w-0 max-w-full flex-[1_1_420px]">
          {/* Drawn to the lorry's own container size; drag to turn it. */}
          <Lorry3D box={lorryBox(v)} height={220} />
        </div>
        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="sr-only">{v.plate}</h1>
            <PlateBadge plate={v.plate} size="lg" />
            <Pill tone={STATUS_TONE[v.status]}>{v.statusLabel}</Pill>
          </div>
          <div className="text-[13.5px] text-ink-secondary">{["In-house", v.model, box, v.driverName, v.region].filter(Boolean).join(" · ")}</div>
          {oos && (
            <div className="rounded-[10px] bg-err-bg px-3 py-2.5 text-[13px] font-semibold text-err">
              Off the road{v.outOfServiceReason ? `: ${v.outOfServiceReason}` : ""}. It cannot be dispatched until the window ends.
            </div>
          )}
          <MissingComplianceNote vehicle={v} compliance={compliance} />
          <div className="grid grid-cols-2 gap-2.5">
            <KpiTile compact label="Mileage" value={v.mileageKm != null ? `${v.mileageKm.toLocaleString()} km` : "Not set"}
              sub={v.mileageDate ? `Read ${fmtDate(v.mileageDate)}${v.mileageFlagged ? " · flagged" : ""}` : "No reading yet"}
              tone={v.mileageFlagged ? "warn" : "neutral"} onClick={() => openTab("maintenance")} />
            <KpiTile compact label="Next document to renew" value={next ? fmtDays(next.days) : "Not set"}
              sub={next ? `${DOC_LABEL[next.type]}, ${fmtDate(next.date)}` : "No expiry on file"}
              tone={next?.tone === "crit" ? "crit" : next?.tone === "warn" ? "warn" : "neutral"} onClick={() => openTab("compliance")} />
            <KpiTile compact label="Open repairs" value={`${openBreakdowns.length + openWorkOrders.length}`}
              sub={`${openBreakdowns.length} breakdown${openBreakdowns.length === 1 ? "" : "s"} · ${openWorkOrders.length} work order${openWorkOrders.length === 1 ? "" : "s"}`}
              tone={openBreakdowns.length ? "warn" : "neutral"} onClick={() => openTab("repairs")} />
            <KpiTile compact label={`Repair spend ${today.slice(0, 4)}`} value={fmtSen(spend.yearSen)} sub={`${fmtSen(spend.monthSen)} this month`} onClick={() => openTab("repairs")} />
          </div>
        </div>
      </section>

      {detail.error && <p role="alert" className="rounded-xl border border-err/30 bg-err-bg px-4 py-2.5 text-[13px] font-semibold text-err">Could not refresh this lorry: {detail.error}</p>}

      <div role="tablist" aria-label="Lorry record" className="flex flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0.5 sm:overflow-x-auto sm:border-b sm:border-[#e0dacd]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => openTab(t.id)}
            className={cn(
              "h-10 shrink-0 rounded-full border px-3.5 text-[14px] transition-colors sm:-mb-px sm:h-11 sm:rounded-none sm:border-0 sm:border-b-2 sm:px-4",
              tab === t.id ? "border-primary bg-primary-soft font-bold text-primary-ink sm:bg-transparent sm:text-primary" : "border-border font-medium text-ink-secondary hover:text-ink sm:border-transparent",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.5fr_1fr]">
          <Section title="Where it is today"><LorryTodayRoute lorryId={v.id} /></Section>
          <Section title="Needs attention">
            {attention.length === 0 ? <p className={EMPTY}>Nothing needs attention.</p> : (
              <ul className="-mx-1 flex flex-col">
                {attention.map((a) => (
                  <li key={a.text} className="border-b border-[#efebe2] last:border-b-0">
                    <button type="button" onClick={() => openTab(a.tab)} className="flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-1 py-2.5 text-left hover:bg-[color:var(--hz-dk-surface-2,#faf9f6)]">
                      <span className={cn("h-2.5 w-2.5 flex-none rounded-full", TONE_DOT[a.tone])} />
                      <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink">{a.text}</span>
                      <Pill tone={a.tone}>{a.tag}</Pill>
                      <span className="text-[13px] font-semibold text-primary">Open</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {tab === "repairs" && (
        <div className="space-y-3">
          <Section title="Repair spend"><RepairSpend workOrders={workOrders} today={today} /></Section>
          <Section title="Breakdowns" sub="A lorry that cannot be driven is off the road until the case is resolved"><BreakdownSection vehicleId={v.id} breakdowns={breakdowns} onChanged={refresh} /></Section>
          <Section title="Work orders"><WorkOrdersSection vehicleId={v.id} plate={v.plate} workOrders={workOrders} breakdowns={breakdowns} onChanged={refresh} /></Section>
        </div>
      )}

      {tab === "maintenance" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <Section title="Off the road" sub="Days this lorry was or will be out of service. While it is off the road it cannot be planned for deliveries.">
            <OffRoadPanel lorryId={v.id} plate={v.plate} onChanged={refresh} />
          </Section>
          <Section title="Mileage" sub={v.mileageFlagged ? "The latest reading is an unusually large jump and is flagged for review." : undefined}><MileageSection readings={detail.data?.mileage ?? []} vehicleId={v.id} onChanged={refresh} /></Section>
          </div>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <Section title="Service plans">
              <PlansSection plans={detail.data?.plans ?? []} currentKm={v.mileageKm} vehicleId={v.id} components={detail.data?.planComponents ?? []} onChanged={refresh} />
            </Section>
            <Section title="Tyres and components">
              <ComponentsSection vehicleId={v.id} currentKm={v.mileageKm} components={detail.data?.components ?? []} onChanged={refresh} />
            </Section>
          </div>
        </div>
      )}

      {tab === "compliance" && <LorryCompliance compliance={compliance} lorryId={v.id} onChanged={refresh} />}

      {tab === "vehicle" && (lorryRow ? (
        <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
          <CapacityCard key={`cap-${lorryRow.id}`} lorry={lorryRow} />
          <PurchaseCard key={`buy-${lorryRow.id}`} lorry={lorryRow} />
        </div>
      ) : (
        <Section title="Vehicle & purchase">
          {lorries.isLoading
            ? <p className={EMPTY}>Loading…</p>
            : <p role="alert" className="text-[13.5px] font-semibold text-err">Could not read this lorry's vehicle details{lorries.error ? `: ${(lorries.error as Error).message}` : "."}</p>}
        </Section>
      ))}
    </div>
  );
}

export default LorryRecord;
