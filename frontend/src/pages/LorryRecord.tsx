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

import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import { useLorries } from "../vendor/scm/lib/lorries-queries";
import { fmtDate, fmtSen, todayMY } from "../vendor/shared/format";
import { PurchaseSection, CapacitySection } from "./scm-v2/LorryDetail";
import { NotifyProvider } from "../vendor/scm/components/NotifyDialog";
import { LorryTodayRoute } from "./fleet/LorryTodayRoute";
import { RepairSpend, repairSpendOf } from "./fleet/RepairSpend";
import { LorryCompliance } from "./fleet/LorryCompliance";
import { StatCard } from "../components/StatCard";
import {
  PlansSection, MileageSection, BreakdownSection, WorkOrdersSection,
  ComponentsSection, MissingComplianceNote, Pill, boxLabel, fmtDays,
  DOC_TYPES, DOC_LABEL, STATUS_TONE,
  type VehicleDetailPayload, type DocType, type Tone,
} from "./FleetHealth";

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="min-w-0 rounded-lg border border-border bg-surface p-4">
    <h2 className="mb-3 text-[14px] font-bold text-ink">{title}</h2>
    {children}
  </section>
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
  const navigate = useNavigate();
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
      <div className="space-y-4">
        <PageHeader eyebrow="Operations · Fleet" title="Lorry not found" description="This lorry is not on file, or you cannot see it." />
        <Link to="/fleet-health" className="text-[12px] text-primary hover:underline">Back to Fleet Health</Link>
      </div>
    );
  }

  const box = boxLabel(v);

  /* Owner, 2026-10-15: Fleet Health is the in-house fleet's record. An outsourced
     lorry is the 3PL's to maintain — it needs only its delivery capacity, which
     is set on Coverage & Fleet. */
  if (v.isInternal === false) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Operations · Fleet" title={v.plate} description="Outsourced lorry" />
        <p className="rounded-md border border-border bg-surface px-4 py-3 text-[12.5px] text-ink-secondary">
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

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Operations · Fleet"
        title={v.plate}
        description={["In-house", v.model, box, v.driverName, v.region].filter(Boolean).join(" · ")}
        actions={
          <button
            type="button"
            onClick={() => navigate("/fleet-health")}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
          >
            <ArrowLeft size={14} /> Fleet Health
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[v.status]}>{v.statusLabel}</Pill>
        {v.outOfService && v.outOfServiceReason && <span className="text-[12px] text-ink-muted">{v.outOfServiceReason}</span>}
      </div>

      <MissingComplianceNote vehicle={v} compliance={compliance} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Mileage" value={v.mileageKm != null ? `${v.mileageKm.toLocaleString()} km` : "—"} subtitle={v.mileageDate ? `Read ${fmtDate(v.mileageDate)}` : "No reading yet"} onClick={() => openTab("maintenance")} />
        <StatCard
          label="Next document to renew"
          value={next ? fmtDays(next.days) : "—"}
          subtitle={next ? `${DOC_LABEL[next.type]}, ${fmtDate(next.date)}` : "No expiry on file"}
          tone={next?.tone === "crit" ? "error" : next?.tone === "warn" ? "warning" : "default"}
          onClick={() => openTab("compliance")}
        />
        <StatCard
          label="Open repairs"
          value={`${openBreakdowns.length + openWorkOrders.length}`}
          subtitle={`${openBreakdowns.length} breakdown${openBreakdowns.length === 1 ? "" : "s"} · ${openWorkOrders.length} work order${openWorkOrders.length === 1 ? "" : "s"}`}
          tone={openBreakdowns.length ? "warning" : "default"}
          onClick={() => openTab("repairs")}
        />
        <StatCard label={`Repair spend ${today.slice(0, 4)}`} value={fmtSen(spend.yearSen)} subtitle={`${fmtSen(spend.monthSen)} this month`} onClick={() => openTab("repairs")} />
      </div>

      <div role="tablist" aria-label="Lorry record" className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => openTab(t.id)}
            className={cn(
              "-mb-px h-11 shrink-0 border-b-2 px-3.5 text-[13px] transition-colors",
              tab === t.id ? "border-primary font-bold text-primary" : "border-transparent font-medium text-ink-secondary hover:text-ink",
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
            {attention.length === 0 ? <p className="text-[13px] text-ink-muted">Nothing needs attention.</p> : (
              <ul className="divide-y divide-border">
                {attention.map((a) => (
                  <li key={a.text}>
                    <button type="button" onClick={() => openTab(a.tab)} className="flex min-h-11 w-full items-center justify-between gap-3 py-2 text-left text-[13px] text-ink hover:text-primary">
                      <span>{a.text}</span>
                      <Pill tone={a.tone}>{a.tag}</Pill>
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
          <Section title="Breakdowns"><BreakdownSection vehicleId={v.id} breakdowns={breakdowns} onChanged={refresh} /></Section>
          <Section title="Work orders"><WorkOrdersSection vehicleId={v.id} plate={v.plate} workOrders={workOrders} breakdowns={breakdowns} onChanged={refresh} /></Section>
        </div>
      )}

      {tab === "maintenance" && (
        <div className="space-y-3">
          <Section title="Mileage"><MileageSection readings={detail.data?.mileage ?? []} vehicleId={v.id} onChanged={refresh} /></Section>
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

      {/* The scm editors report through the scm dialog, so each carries its provider here. */}
      {tab === "vehicle" && (lorryRow ? (
        <div className="space-y-3">
          <NotifyProvider><CapacitySection lorry={lorryRow} ownFleet /></NotifyProvider>
          <NotifyProvider><PurchaseSection lorry={lorryRow} /></NotifyProvider>
        </div>
      ) : (
        <Section title="Vehicle and purchase">
          <p className="text-[13px] text-ink-muted">{lorries.isLoading ? "Loading…" : "The lorry master row could not be read."}</p>
        </Section>
      ))}
    </div>
  );
}

export default LorryRecord;
