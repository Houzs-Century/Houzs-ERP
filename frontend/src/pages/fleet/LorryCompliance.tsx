// The Compliance tab of a lorry: one card per document, answering the question
// the page is opened for, how long until this one must be renewed. Older renewals
// stay behind a toggle; they are the audit trail, not what is being looked at.
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { fmtDate } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { AddRenewalForm, AttachmentStrip, DOC_LABEL, DOC_TYPES, Pill, fmtDays, money, type DocType, type DocView, type Tone, type VehicleDetailPayload } from "../FleetHealth";

/** The chip of a document. Geran has no expiry, so it is simply on file. */
export function docChip(doc: DocView | null, flatExpiry: string | null): { label: string; tone: Tone } {
  if (doc?.result === "FAIL") return { label: "Failed", tone: "crit" };
  if (doc?.daysRemaining != null) return { label: fmtDays(doc.daysRemaining), tone: doc.tone };
  if (doc) return { label: "On file", tone: "ok" };
  return flatExpiry ? { label: "No document yet", tone: "warn" } : { label: "Nothing on file", tone: "warn" };
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <div className="text-[11.5px] text-ink-muted">{label}</div>
    <div className="mt-0.5 truncate text-[13px] tabular-nums text-ink">{children}</div>
  </div>
);

function DocCard({ type, group, lorryId, onChanged }: {
  type: DocType;
  group: VehicleDetailPayload["compliance"][DocType] | undefined;
  lorryId: string;
  onChanged: () => void;
}) {
  const [showOld, setShowOld] = useState(false);
  const history = group?.history ?? [];
  const current = history.find((d) => d.id === group?.currentId) ?? null;
  const older = history.filter((d) => d !== current);
  const chip = docChip(current, group?.flatExpiry ?? null);
  const expiry = current?.expiryDate ?? group?.flatExpiry ?? null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-bold text-ink">{DOC_LABEL[type]}</h3>
          <div className="mt-0.5 text-[12px] text-ink-muted">{current?.documentRef || "No document number"}</div>
        </div>
        <Pill tone={chip.tone}>{chip.label}</Pill>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Fact label="Expires">{expiry ? fmtDate(expiry) : current ? "No expiry" : "—"}</Fact>
        <Fact label="Issued">{current?.issueDate ? fmtDate(current.issueDate) : "—"}</Fact>
        {type === "PUSPAKOM"
          ? <Fact label="Result">{current?.result === "PASS" ? "Pass" : current?.result === "FAIL" ? "Fail" : "—"}</Fact>
          : <Fact label="Cost">{current?.costSen != null ? money(current.costSen) : "—"}</Fact>}
      </div>
      {current?.result === "FAIL" && current.reinspectionDeadline && (
        <p className="text-[12px] text-err">Reinspect by {fmtDate(current.reinspectionDeadline)}</p>
      )}
      {current?.owner && <p className="text-[12px] text-ink-muted">Renewed by {current.owner}</p>}

      {current && <AttachmentStrip docId={current.id} files={current.files ?? []} onChanged={onChanged} />}

      {older.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowOld((o) => !o)} aria-expanded={showOld} className="inline-flex min-h-9 items-center gap-1 text-[12px] font-medium text-ink-secondary hover:text-primary">
            <ChevronRight size={13} className={cn("transition-transform", showOld && "rotate-90")} />
            Earlier renewals ({older.length})
          </button>
          {showOld && (
            <ul className="mt-1 space-y-2 border-l border-border pl-3">
              {older.map((d) => (
                <li key={d.id ?? `${d.docType}-${d.expiryDate}`} className="text-[12px] text-ink-secondary">
                  <div className="flex justify-between gap-3">
                    <span className="truncate">{d.documentRef || DOC_LABEL[type]}</span>
                    <span className="shrink-0 tabular-nums">{d.expiryDate ? fmtDate(d.expiryDate) : "No expiry"}</span>
                  </div>
                  <AttachmentStrip docId={d.id} files={d.files ?? []} onChanged={onChanged} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AddRenewalForm lorryId={lorryId} docType={type} onSaved={onChanged} />
    </section>
  );
}

export function LorryCompliance({ compliance, lorryId, onChanged }: { compliance: VehicleDetailPayload["compliance"] | undefined; lorryId: string; onChanged: () => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {DOC_TYPES.map((t) => <DocCard key={t} type={t} group={compliance?.[t]} lorryId={lorryId} onChanged={onChanged} />)}
    </div>
  );
}
