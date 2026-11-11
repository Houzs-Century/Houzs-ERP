// The Compliance tab of a lorry: one card per document, answering the question
// the page is opened for, how long until this one must be renewed. Older renewals
// stay behind a toggle; they are the audit trail, not what is being looked at.
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { fmtDate } from "../../vendor/shared/format";
import { cn } from "../../lib/utils";
import { BTN_GHOST, CARD, orNotSet } from "./FleetUi";
import { AddRenewalForm, AttachmentStrip, DOC_LABEL, DOC_TYPES, Pill, fmtDays, money, type DocType, type DocView, type Tone, type VehicleDetailPayload } from "../FleetHealth";

/** The chip of a document. Geran has no expiry, so it is simply on file. */
export function docChip(doc: DocView | null, flatExpiry: string | null): { label: string; tone: Tone } {
  if (doc?.result === "FAIL") return { label: "Failed", tone: "crit" };
  if (doc?.daysRemaining != null) return { label: fmtDays(doc.daysRemaining), tone: doc.tone };
  if (doc) return { label: "On file", tone: "ok" };
  return flatExpiry ? { label: "No document yet", tone: "warn" } : { label: "Nothing on file", tone: "warn" };
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => {
  const v = orNotSet(children);
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words tabular-nums", v === children ? "font-medium text-ink" : "text-ink-muted")}>{v}</dd>
    </>
  );
};

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
    <section className={cn(CARD, "flex min-w-0 flex-col gap-3 p-4 sm:px-5 sm:py-[18px]")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-ink">{DOC_LABEL[type]}</h3>
          <div className="mt-0.5 text-[12.5px] text-ink-muted">{current ? current.documentRef || "No document number" : "No document yet"}</div>
        </div>
        <Pill tone={chip.tone}>{chip.label}</Pill>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 rounded-xl bg-[color:var(--hz-dk-surface-2,#faf9f6)] px-3.5 py-3 text-[13px]">
        <Row label="Expires">{expiry ? fmtDate(expiry) : current ? "No expiry" : null}</Row>
        <Row label="Issued">{current?.issueDate ? fmtDate(current.issueDate) : null}</Row>
        {type === "PUSPAKOM"
          ? <Row label="Result">{current?.result === "PASS" ? "Pass" : current?.result === "FAIL" ? "Fail" : null}</Row>
          : <Row label="Cost">{current?.costSen != null ? money(current.costSen) : null}</Row>}
        {current?.result === "FAIL" && current.reinspectionDeadline && (
          <><dt className="text-err">Reinspect by</dt><dd className="font-semibold text-err">{fmtDate(current.reinspectionDeadline)}</dd></>
        )}
        <Row label="Renewed by">{current?.owner ?? null}</Row>
      </dl>

      {current && <AttachmentStrip docId={current.id} files={current.files ?? []} onChanged={onChanged} />}

      {older.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowOld((o) => !o)} aria-expanded={showOld} className={BTN_GHOST}>
            <ChevronRight size={13} className={cn("transition-transform", showOld && "rotate-90")} />
            Earlier renewals ({older.length})
          </button>
          {showOld && (
            <ul className="mt-1 flex flex-col rounded-lg bg-[color:var(--hz-dk-surface-2,#faf9f6)] px-3 py-1">
              {older.map((d) => (
                <li key={d.id ?? `${d.docType}-${d.expiryDate}`} className="flex flex-col gap-1.5 border-b border-[#efebe2] py-2 text-[12.5px] text-ink-secondary last:border-b-0">
                  <div className="flex justify-between gap-3">
                    <span className="truncate">{d.documentRef || DOC_LABEL[type]}</span>
                    <span className="shrink-0 tabular-nums text-ink-muted">{d.issueDate ? `${fmtDate(d.issueDate)} to ` : ""}{d.expiryDate ? fmtDate(d.expiryDate) : "No expiry"}</span>
                  </div>
                  <AttachmentStrip docId={d.id} files={d.files ?? []} onChanged={onChanged} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="border-t border-[#ece8df] pt-3"><AddRenewalForm lorryId={lorryId} docType={type} onSaved={onChanged} /></div>
    </section>
  );
}

export function LorryCompliance({ compliance, lorryId, onChanged }: { compliance: VehicleDetailPayload["compliance"] | undefined; lorryId: string; onChanged: () => void }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))" }}>
      {DOC_TYPES.map((t) => <DocCard key={t} type={t} group={compliance?.[t]} lorryId={lorryId} onChanged={onChanged} />)}
    </div>
  );
}
