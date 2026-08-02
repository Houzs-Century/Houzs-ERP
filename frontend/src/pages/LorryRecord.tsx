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

import { useParams, useNavigate, Link } from "react-router-dom";
import { ArrowLeft, Truck } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { ListSkeleton } from "../components/Skeleton";
import { useQuery } from "../hooks/useQuery";
import { api } from "../api/client";
import { cn } from "../lib/utils";
import {
  PlansSection, MileageSection, BreakdownSection, WorkOrdersSection,
  ComponentsSection, AttachmentStrip, AddRenewalForm,
  MissingComplianceNote, Pill, money, boxLabel,
  DOC_TYPES, DOC_LABEL, STATUS_TONE,
  type VehicleDetailPayload, type DocView,
} from "./FleetHealth";

/** A titled block with the accent rule, so the page reads as sections rather
 *  than one long scroll — the complaint that produced this page. */
const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="rounded-lg border border-border bg-surface">
    <header className="flex items-center gap-2 border-b border-border bg-surface-2/40 px-4 py-2.5">
      <h2 className="font-display text-[11px] font-bold uppercase tracking-brand text-primary">{title}</h2>
      {hint && <span className="text-[10.5px] text-ink-muted">{hint}</span>}
    </header>
    <div className="p-4">{children}</div>
  </section>
);

const DateFact = ({ label, value, hint }: { label: string; value: string | null; hint: string }) => (
  <div>
    <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">{label}</div>
    <div className={cn("mt-0.5 text-[13px] tabular-nums", value ? "text-ink" : "text-ink-muted")}>{value ?? "—"}</div>
    <div className="mt-0.5 text-[10.5px] leading-snug text-ink-muted">{hint}</div>
  </div>
);

export function LorryRecord() {
  const { lorryId = "" } = useParams();
  const navigate = useNavigate();

  const path = `/api/fleet-maintenance/vehicles/${encodeURIComponent(lorryId)}`;
  const detail = useQuery<VehicleDetailPayload>(path, () => api.get(path), [lorryId]);
  const refresh = () => detail.reload();

  const v = detail.data?.vehicle;
  const compliance = detail.data?.compliance;

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

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Operations · Fleet"
        title={v.plate}
        description={[
          v.isInternal === false ? "Outsourced" : "In-house",
          v.model, box, v.driverName, v.region,
        ].filter(Boolean).join(" · ") || "No particulars on file"}
        actions={
          <button
            type="button"
            onClick={() => navigate("/fleet-health")}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary"
          >
            <ArrowLeft size={14} /> Fleet Health
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[v.status]}>{v.statusLabel}</Pill>
        <span className="text-[12px] text-ink-muted">
          {v.mileageKm != null ? `${v.mileageKm.toLocaleString()} km` : "no mileage reading"}
          {v.mileageDate ? ` · ${v.mileageDate}` : ""}
        </span>
      </div>

      <MissingComplianceNote vehicle={v} compliance={compliance} />

      {/* The lorry's own lifecycle. Four dates that answer four different
          questions and are routinely confused for each other — mig 0245. */}
      <Section title="Vehicle" hint="dates the lorry's life is measured from">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <DateFact label="Manufactured" value={v.manufactureDate ?? null}
            hint="How old the vehicle is. Drives depreciation and parts availability." />
          <DateFact label="Registered" value={v.registrationDate ?? null}
            hint="The JPJ registration — what road tax, insurance and PUSPAKOM cycles anchor to." />
          <DateFact label="In service" value={v.inServiceDate ?? null}
            hint="First day it worked for us. The denominator for cost-per-day." />
          <DateFact label="Purchased" value={v.purchaseDate ?? null}
            hint={v.purchasePriceCenti != null ? `We bought it for ${money(v.purchasePriceCenti)}.` : "When we bought it."} />
        </div>
        <p className="mt-3 text-[10.5px] leading-snug text-ink-muted">
          These are not the same date and the system never guesses one from another — a reconditioned import is
          registered here long after it was built, and a lorry can start work before its transfer paperwork clears.
          Edit them on the lorry master under Coverage &amp; Fleet.
        </p>
      </Section>

      <Section title="Breakdown & incidents" hint="a critical, unresolved case grounds the lorry">
        <BreakdownSection vehicleId={v.id} breakdowns={detail.data?.breakdowns ?? []} onChanged={refresh} />
      </Section>

      <Section title="Work orders" hint="Reported → Diagnosed → Approved → In Repair → Waiting Parts → Completed → Verified">
        <WorkOrdersSection vehicleId={v.id} plate={v.plate} workOrders={detail.data?.workOrders ?? []} breakdowns={detail.data?.breakdowns ?? []} onChanged={refresh} />
      </Section>

      <Section title="Tyres & components" hint="serial lifecycle · km used + cost/km derived">
        <ComponentsSection vehicleId={v.id} currentKm={v.mileageKm} components={detail.data?.components ?? []} onChanged={refresh} />
      </Section>

      <Section title="Preventive maintenance" hint="per component · due on whichever comes first (km or months)">
        <PlansSection
          plans={detail.data?.plans ?? []}
          currentKm={v.mileageKm}
          vehicleId={v.id}
          components={detail.data?.planComponents ?? []}
          onChanged={refresh}
        />
      </Section>

      <Section title="Mileage" hint="the driver captures the odometer on day-complete from the mobile app">
        <MileageSection readings={detail.data?.mileage ?? []} />
      </Section>

      <Section title="Compliance vault" hint="current document + renewal history (append-only)">
        <div className="space-y-4">
          {DOC_TYPES.map((t) => {
            const group = compliance?.[t];
            const history = group?.history ?? [];
            const currentId = group?.currentId ?? null;
            return (
              <div key={t} className="rounded-lg border border-border bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[12.5px] font-semibold text-ink">{DOC_LABEL[t]}</span>
                  {history.length === 0 && <span className="text-[11px] text-ink-muted">No document on file</span>}
                </div>
                {history.length > 0 && (
                  <div className="space-y-1.5">
                    {history.map((doc: DocView) => (
                      <div
                        key={doc.id ?? `${doc.docType}-${doc.expiryDate}`}
                        className={cn(
                          "flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-[12px]",
                          doc.id === currentId ? "border-border bg-surface" : "border-transparent bg-transparent opacity-70",
                        )}
                      >
                        <div>
                          <div className="text-ink">
                            {doc.documentRef || DOC_LABEL[t]}
                            {doc.id === currentId && (
                              <span className="ml-2 rounded bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-primary">Current</span>
                            )}
                          </div>
                          <div className="text-[10.5px] text-ink-muted">
                            {doc.issueDate ? `Issued ${doc.issueDate}` : "No issue date"}
                            {doc.owner ? ` · ${doc.owner}` : ""}
                            {doc.costCenti != null ? ` · ${money(doc.costCenti)}` : ""}
                            {doc.result ? ` · ${doc.result}` : ""}
                            {doc.result === "FAIL" && doc.reinspectionDeadline ? ` · reinspect by ${doc.reinspectionDeadline}` : ""}
                          </div>
                          <AttachmentStrip docId={doc.id} files={doc.files ?? []} onChanged={refresh} />
                        </div>
                        <div className="text-right">
                          <div className="tabular-nums text-ink">{doc.expiryDate ?? "—"}</div>
                          <div className={cn(
                            "text-[10.5px]",
                            doc.tone === "crit" ? "text-err" : doc.tone === "warn" ? "text-warning-text" : "text-ink-muted",
                          )}>
                            {doc.reminderLevel}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <AddRenewalForm lorryId={v.id} docType={t} onSaved={refresh} />
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[10.5px] leading-snug text-ink-muted">
          Renew by ADDING a row — nothing is overwritten, so the list above is the audit trail.
        </p>
      </Section>

      <div className="flex items-center gap-2 pb-6 text-[11px] text-ink-muted">
        <Truck size={13} /> Work-order totals and active breakdowns feed the fleet KPIs on Fleet Health.
      </div>
    </div>
  );
}

export default LorryRecord;
