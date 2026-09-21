// Factory-return (返厂) list — the shared presentation for BOTH the desktop
// Supplier panel (pages/ServiceCases.tsx) and the mobile Stage tab
// (mobile/MobileServiceCase.tsx). Every trip to the factory is a row; ops adds
// as many as needed (a real case has been back 4 times). The latest row is the
// CURRENT trip and the case's Supplier Pickup / Return columns mirror it for the
// delivery board + HC sheet. The logic (labels, next number, count, which is
// current) lives in vendor/scm/lib/assr/returns.ts and is shared with the
// server. Data + callbacks only, no fetching — so it drops into a harness with
// mock rows.
import { useState } from "react";
import {
  type SupplierReturn,
  currentRound,
  roundCount,
  roundLabel,
  QC_RESULTS,
  qcResultLabel,
} from "../../vendor/scm/lib/assr/returns";
import { DateField } from "../../vendor/scm/components/DateField";

export interface SupplierReturnsListProps {
  returns: SupplierReturn[];
  canWrite: boolean;
  /** True while a round mutation is in flight — disables the controls. */
  busy?: boolean;
  /** Add another factory trip (round N+1) and reopen the case onto the supplier
   *  stage. `reason` = why it goes back (blank for the first trip). */
  onAdd: (reason: string | null) => void | Promise<void>;
  /** Edit one trip's fields. */
  onPatch: (roundId: number, patch: Record<string, string | null>) => void | Promise<void>;
  /** Remove a mistaken trip. */
  onArchive: (roundId: number) => void | Promise<void>;
  /** DD/MM/YYYY formatter from the host surface; falls back to the raw string. */
  formatDate?: (s: string | null | undefined) => string;
  /** Confirm gate for the two destructive-ish actions (add, remove). */
  confirm?: (msg: string) => boolean | Promise<boolean>;
}

const LABEL = "text-[11px] font-medium text-ink-muted";
const FIELD =
  "w-full rounded-md border border-border bg-surface px-2 py-1 text-[13px] text-ink-secondary outline-none focus:border-primary disabled:opacity-60";

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

function TripCard({
  r,
  isCurrent,
  canWrite,
  busy,
  onPatch,
  onArchive,
  formatDate,
  confirm,
}: {
  r: SupplierReturn;
  isCurrent: boolean;
} & Pick<SupplierReturnsListProps, "canWrite" | "busy" | "onPatch" | "onArchive" | "formatDate" | "confirm">) {
  const fmt = formatDate ?? ((s) => s || "—");
  // Uncontrolled inputs keyed by the persisted value: a save + parent reload
  // resets them; text saves on blur so a reload never yanks focus mid-word.
  const save = (field: string, v: string) => {
    if ((r[field as keyof SupplierReturn] ?? "") === v) return;
    void onPatch(r.id, { [field]: v || null });
  };

  const dateField = (field: "pickup_at" | "returned_at", label: string) =>
    canWrite ? (
      <Labeled label={label}>
        <DateField
          value={r[field] ?? ""}
          onChange={(iso) => save(field, iso)}
          disabled={busy}
          fullWidth
          aria-label={label}
        />
      </Labeled>
    ) : (
      <div className="flex flex-col gap-1">
        <span className={LABEL}>{label}</span>
        <span className="text-[13px] text-ink-secondary">{fmt(r[field])}</span>
      </div>
    );

  return (
    <div className={`space-y-2 rounded-md border bg-surface px-3 py-2.5 ${isCurrent ? "border-primary/50" : "border-border-subtle"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-ink">{roundLabel(r.round_no)}</span>
          {isCurrent && (
            <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">Current</span>
          )}
        </div>
        {canWrite && (
          <button
            type="button"
            disabled={busy}
            className="text-[11px] font-semibold text-ink-muted hover:text-ink-secondary disabled:opacity-60"
            onClick={async () => {
              const ok = confirm ? await confirm(`Remove ${roundLabel(r.round_no)}?`) : true;
              if (ok) void onArchive(r.id);
            }}
          >
            Remove
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {dateField("pickup_at", "Sent to Supplier")}
        {dateField("returned_at", "Back from Supplier")}
        <Labeled label="QC Result">
          {canWrite ? (
            <select
              className={FIELD}
              defaultValue={r.qc_result ?? ""}
              disabled={busy}
              key={`qc:${r.qc_result ?? ""}`}
              onChange={(e) => save("qc_result", e.target.value)}
            >
              <option value="">—</option>
              {QC_RESULTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <span className="text-[13px] text-ink-secondary">{qcResultLabel(r.qc_result)}</span>
          )}
        </Labeled>
        <Labeled label="Supplier">
          {canWrite ? (
            <input
              className={FIELD}
              defaultValue={r.creditor_code ?? ""}
              placeholder={r.creditor_name ?? "Supplier code"}
              disabled={busy}
              key={`cr:${r.creditor_code ?? ""}`}
              onBlur={(e) => save("creditor_code", e.target.value.trim())}
            />
          ) : (
            <span className="text-[13px] text-ink-secondary">{r.creditor_name || r.creditor_code || "—"}</span>
          )}
        </Labeled>
      </div>

      <Labeled label={r.round_no > 1 ? "Why Sent Back Again" : "Reason (Optional)"}>
        {canWrite ? (
          <input
            className={FIELD}
            defaultValue={r.reason ?? ""}
            placeholder={r.round_no > 1 ? "QC failed / broke again / wrong part…" : ""}
            disabled={busy}
            key={`rs:${r.reason ?? ""}`}
            onBlur={(e) => save("reason", e.target.value.trim())}
          />
        ) : (
          <span className="text-[13px] text-ink-secondary">{r.reason || "—"}</span>
        )}
      </Labeled>

      {(canWrite || r.note) && (
        <Labeled label="Note">
          {canWrite ? (
            <textarea
              className={FIELD}
              rows={2}
              defaultValue={r.note ?? ""}
              disabled={busy}
              key={`nt:${r.note ?? ""}`}
              onBlur={(e) => save("note", e.target.value.trim())}
            />
          ) : (
            <span className="whitespace-pre-wrap text-[13px] text-ink-secondary">{r.note}</span>
          )}
        </Labeled>
      )}
    </div>
  );
}

export function SupplierReturnsList({
  returns,
  canWrite,
  busy,
  onAdd,
  onPatch,
  onArchive,
  formatDate,
  confirm,
}: SupplierReturnsListProps) {
  const [reason, setReason] = useState("");
  const [adding, setAdding] = useState(false);
  const ordered = [...returns].sort((a, b) => a.round_no - b.round_no);
  const cur = currentRound(returns);
  const count = roundCount(returns);
  const firstTrip = count === 0;

  const add = async () => {
    const ok = firstTrip || !confirm
      ? true
      : await confirm("Add another supplier return? This reopens the case onto the supplier stage and starts a new return.");
    if (!ok) return;
    await onAdd(reason.trim() || null);
    setReason("");
    setAdding(false);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-ink-secondary">Supplier Returns</span>
        {count > 0 && (
          <span className="rounded bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {count === 1 ? "1 trip" : `${count} trips`}
          </span>
        )}
      </div>

      {firstTrip && (
        <p className="text-[12px] text-ink-muted">No supplier return recorded yet.</p>
      )}

      {ordered.map((r) => (
        <TripCard
          key={r.id}
          r={r}
          isCurrent={cur?.id === r.id}
          canWrite={canWrite}
          busy={busy}
          onPatch={onPatch}
          onArchive={onArchive}
          formatDate={formatDate}
          confirm={confirm}
        />
      ))}

      {canWrite && (
        adding && !firstTrip ? (
          <div className="space-y-2 rounded-md border border-dashed border-border bg-surface px-3 py-2.5">
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
                className="rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90 disabled:opacity-60"
              >
                Add Return
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setReason(""); }}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:border-primary/40"
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
            className="rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90 disabled:opacity-60"
          >
            + Add Supplier Return
          </button>
        )
      )}
    </div>
  );
}
