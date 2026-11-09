// Factory-return (返厂) list — the shared presentation for BOTH the desktop
// Supplier panel (pages/ServiceCases.tsx) and the mobile Stage tab
// (mobile/MobileServiceCase.tsx). Every trip to the factory is a row; ops adds
// as many as needed (a real case has been back 4 times). The latest row is the
// CURRENT trip and the case's Supplier Pickup / Return columns mirror it for the
// delivery board + HC sheet. The logic (labels, next number, count, which is
// current) lives in vendor/scm/lib/assr/returns.ts and is shared with the
// server. Self-contained: it owns its writes (caseId + api) so the host surface
// only supplies the rows + a reload/error hook. Trips are tabs (Operation Dept
// 2026-11-09): the current one opens, older ones stay one tap away.
import { useState, type ReactElement, type ReactNode } from "react";
import {
  type SupplierReturn,
  currentRound,
  roundCount,
  roundLabel,
  shownRound,
  tripTabLabel,
  QC_RESULTS,
  qcResultLabel,
  returnNotePath,
} from "../../vendor/scm/lib/assr/returns";
import { DateField } from "../../vendor/scm/components/DateField";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";
import { CaseSection } from "./CaseSection";

export interface SupplierReturnsListProps {
  returns: SupplierReturn[];
  canWrite: boolean;
  /** The service-case id these trips belong to. */
  caseId: number;
  /** Refetch the case after a successful write. */
  onChanged: () => void;
  /** Surface a write failure to the user. */
  onError: (msg: string) => void;
  /** DD/MM/YYYY formatter from the host surface; falls back to the raw string. */
  formatDate?: (s: string | null | undefined) => string;
  /** Confirm gate for the two destructive-ish actions (add, remove). */
  confirm?: (msg: string) => boolean | Promise<boolean>;
}

type TripDateField = "pickup_at" | "expected_return_at" | "returned_at";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-ink-muted";
const FIELD =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60";
const PAIR = "grid grid-cols-1 gap-2.5 sm:grid-cols-2";

function Labeled({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      <span className="whitespace-pre-wrap text-[13px] text-ink-secondary">{value}</span>
    </div>
  );
}

interface TripFieldsProps {
  r: SupplierReturn;
  caseId: number;
  isCurrent: boolean;
  canWrite: boolean;
  busy: boolean;
  onPatch: (roundId: number, patch: Record<string, string | null>) => void;
  onArchive: (roundId: number) => void;
  onError: (msg: string) => void;
  formatDate?: (s: string | null | undefined) => string;
  confirm?: (msg: string) => boolean | Promise<boolean>;
}

function TripFields({ r, caseId, isCurrent, canWrite, busy, onPatch, onArchive, onError, formatDate, confirm }: TripFieldsProps): ReactElement {
  const fmt = formatDate ?? ((s) => s || "—");
  // Uncontrolled inputs keyed by the persisted value: a save + parent reload
  // resets them; text saves on blur so a reload never yanks focus mid-word.
  const save = (field: keyof SupplierReturn, value: string) => {
    if ((r[field] ?? "") === value) return;
    void onPatch(r.id, { [field]: value || null });
  };

  const dateField = (field: TripDateField, label: string) =>
    canWrite ? (
      <Labeled label={label}>
        <DateField value={r[field] ?? ""} onChange={(iso) => save(field, iso)} disabled={busy} fullWidth aria-label={label} />
      </Labeled>
    ) : (
      <ReadOnly label={label} value={fmt(r[field])} />
    );

  const textField = (field: "reason" | "note", label: string, placeholder: string) =>
    canWrite ? (
      <Labeled label={label}>
        <textarea
          className={cn(FIELD, "min-h-[60px] resize-y")}
          rows={2}
          defaultValue={r[field] ?? ""}
          placeholder={placeholder}
          disabled={busy}
          key={`${field}:${r[field] ?? ""}`}
          onBlur={(e) => save(field, e.target.value.trim())}
        />
      </Labeled>
    ) : (
      <ReadOnly label={label} value={r[field] || "—"} />
    );

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink">{roundLabel(r.round_no)}</span>
          {r.ref_no && <span className="font-mono text-[11px] text-ink-muted">{r.ref_no}</span>}
          {isCurrent && (
            <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">Current</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="min-h-[32px] text-[11px] font-semibold text-primary hover:opacity-80"
            onClick={() => {
              void api.openHtml(returnNotePath(caseId, r.id)).catch((e: unknown) =>
                onError(e instanceof Error ? e.message : "Couldn't open the return note"),
              );
            }}
          >
            Print
          </button>
          {canWrite && (
            <button
              type="button"
              disabled={busy}
              className="min-h-[32px] text-[11px] font-semibold text-ink-muted hover:text-ink-secondary disabled:opacity-60"
              onClick={async () => {
                const ok = confirm ? await confirm(`Remove ${roundLabel(r.round_no)}?`) : true;
                if (ok) void onArchive(r.id);
              }}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {canWrite ? (
        <Labeled label="Supplier">
          <input
            className={FIELD}
            defaultValue={r.creditor_code ?? ""}
            placeholder={r.creditor_name ?? "Supplier code"}
            disabled={busy}
            key={`cr:${r.creditor_code ?? ""}`}
            onBlur={(e) => save("creditor_code", e.target.value.trim())}
          />
        </Labeled>
      ) : (
        <ReadOnly label="Supplier" value={r.creditor_name || r.creditor_code || "—"} />
      )}

      <div className={PAIR}>
        {dateField("pickup_at", "Sent to Supplier")}
        {dateField("expected_return_at", "Back from Supplier (ETA)")}
      </div>

      {textField(
        "reason",
        r.round_no > 1 ? "Why Sent Back Again" : "Reason for Return",
        r.round_no > 1 ? "QC failed / broke again / wrong part…" : "",
      )}

      <div className={PAIR}>
        {canWrite ? (
          <Labeled label="QC Result">
            <select
              className={FIELD}
              defaultValue={r.qc_result ?? ""}
              disabled={busy}
              key={`qc:${r.qc_result ?? ""}`}
              onChange={(e) => save("qc_result", e.target.value)}
            >
              <option value="">Pending QC</option>
              {QC_RESULTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </Labeled>
        ) : (
          <ReadOnly label="QC Result" value={r.qc_result ? qcResultLabel(r.qc_result) : "Pending QC"} />
        )}
        {dateField("returned_at", "Actual Back Date")}
      </div>

      {(canWrite || r.note) && textField("note", "Remarks", "Additional notes…")}
    </div>
  );
}

function TripTabs({ trips, shownId, currentId, onPick }: {
  trips: SupplierReturn[];
  shownId: number | null;
  currentId: number | null;
  onPick: (id: number) => void;
}): ReactElement {
  return (
    <div role="tablist" aria-label="Supplier return trips" className="flex flex-wrap gap-1.5">
      {trips.map((trip) => (
        <button
          key={trip.id}
          type="button"
          role="tab"
          aria-selected={trip.id === shownId}
          onClick={() => onPick(trip.id)}
          className={cn(
            "min-h-[36px] rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
            trip.id === shownId
              ? "border-primary bg-primary-soft text-primary"
              : "border-border bg-surface text-ink-secondary hover:border-primary/40",
          )}
        >
          {tripTabLabel(trip.round_no)}
          {trip.id === currentId ? " · Current" : ""}
        </button>
      ))}
    </div>
  );
}

export function SupplierReturnsList({
  returns,
  canWrite,
  caseId,
  onChanged,
  onError,
  formatDate,
  confirm,
}: SupplierReturnsListProps): ReactElement {
  const [reason, setReason] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickedTripId, setPickedTripId] = useState<number | null>(null);
  const ordered = [...returns].filter((r) => !r.archived_at).sort((a, b) => a.round_no - b.round_no);
  const cur = currentRound(returns);
  const shown = shownRound(ordered, pickedTripId);
  const count = roundCount(returns);
  const firstTrip = count === 0;

  const run = (fn: () => Promise<unknown>, afterSave?: () => void) => {
    setBusy(true);
    void fn()
      .then(() => { afterSave?.(); onChanged(); })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : "Couldn't save the supplier return"))
      .finally(() => setBusy(false));
  };
  const onAdd = (r: string | null) =>
    run(() => api.post(`/api/assr/${caseId}/supplier-returns`, { reason: r }), () => setPickedTripId(null));
  const onPatch = (roundId: number, patch: Record<string, string | null>) => run(() => api.patch(`/api/assr/${caseId}/supplier-returns/${roundId}`, patch));
  const onArchive = (roundId: number) =>
    run(() => api.del(`/api/assr/${caseId}/supplier-returns/${roundId}`), () => setPickedTripId(null));

  const add = async () => {
    const ok = firstTrip || !confirm
      ? true
      : await confirm("Add another supplier return? This reopens the case onto the supplier stage and starts a new return. Earlier trips stay on their own tabs.");
    if (!ok) return;
    onAdd(reason.trim() || null);
    setReason("");
    setAdding(false);
  };

  return (
    <CaseSection title="3. Supplier Service / Return" badge={count > 1 ? `${count} trips` : null} icon={null} action={null} isCollapsible={false}>
      {firstTrip && (
        <p className="text-[12px] text-ink-muted">No supplier return recorded yet.</p>
      )}

      {count > 1 && (
        <TripTabs trips={ordered} shownId={shown?.id ?? null} currentId={cur?.id ?? null} onPick={setPickedTripId} />
      )}

      {shown && (
        <TripFields
          key={shown.id}
          r={shown}
          caseId={caseId}
          isCurrent={cur?.id === shown.id}
          canWrite={canWrite}
          busy={busy}
          onPatch={onPatch}
          onArchive={onArchive}
          onError={onError}
          formatDate={formatDate}
          confirm={confirm}
        />
      )}

      {canWrite && (
        adding && !firstTrip ? (
          <div className="space-y-2 rounded-md border border-dashed border-border px-3 py-2.5">
            <Labeled label="Why Sent Back Again">
              <input
                className={FIELD}
                value={reason}
                autoFocus
                placeholder="QC failed / broke again / wrong part…"
                onChange={(e) => setReason(e.target.value)}
              />
            </Labeled>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={add}
                className="min-h-[36px] rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90 disabled:opacity-60"
              >
                Add Return
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setReason(""); }}
                className="min-h-[36px] rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-primary/40"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => (firstTrip ? add() : setAdding(true))}
            className="min-h-[36px] rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90 disabled:opacity-60"
          >
            {firstTrip ? "+ Add Supplier Return" : "+ Send Back Again (New Trip)"}
          </button>
        )
      )}
    </CaseSection>
  );
}
