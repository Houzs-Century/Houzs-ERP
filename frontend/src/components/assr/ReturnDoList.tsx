import { useState, type ReactElement, type ReactNode } from "react";
import { api } from "../../api/client";
import { DateField } from "../../vendor/scm/components/DateField";
import { RECEIVED_BY_SUGGESTIONS, returnDoPath, type ReturnDo } from "../../vendor/scm/lib/assr/item-ready";

export interface ReturnDoListProps {
  caseId: number;
  returnDos: ReturnDo[];
  canWrite: boolean;
  isAdding: boolean;
  onAddingChange: (isAdding: boolean) => void;
  renderAttachment: (doId: number) => ReactNode;
  onChanged: () => void;
  onError: (message: string) => void;
  confirm: (message: string) => boolean | Promise<boolean>;
  formatDate: (value: string | null | undefined) => string;
}

type ReturnDoField = "do_no" | "do_date" | "received_at" | "received_by" | "remarks";

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-ink-muted";
const FIELD =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60";
const PAIR = "grid grid-cols-1 gap-2.5 sm:grid-cols-2";
const RECEIVED_BY_LIST_ID = "assr-received-by-suggestions";

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

interface ReturnDoRowProps {
  row: ReturnDo;
  canWrite: boolean;
  busy: boolean;
  attachment: ReactNode;
  onSave: (field: ReturnDoField, value: string) => void;
  onRemove: () => void;
  formatDate: (value: string | null | undefined) => string;
}

function ReturnDoRow({ row, canWrite, busy, attachment, onSave, onRemove, formatDate }: ReturnDoRowProps): ReactElement {
  const text = (field: "do_no" | "received_by", label: string, placeholder: string) => (
    <Field label={label}>
      {canWrite ? (
        <input className={FIELD} defaultValue={row[field] ?? ""} placeholder={placeholder} disabled={busy}
          list={field === "received_by" ? RECEIVED_BY_LIST_ID : undefined}
          key={`${field}:${row[field] ?? ""}`} onBlur={(event) => onSave(field, event.target.value.trim())} />
      ) : (
        <span className="text-[13px] text-ink-secondary">{row[field] || "—"}</span>
      )}
    </Field>
  );
  const date = (field: "do_date" | "received_at", label: string) => (
    <Field label={label}>
      {canWrite ? (
        <DateField value={row[field] ?? ""} onChange={(iso) => onSave(field, iso)} disabled={busy} fullWidth aria-label={label} />
      ) : (
        <span className="text-[13px] text-ink-secondary">{formatDate(row[field])}</span>
      )}
    </Field>
  );

  return (
    <div className="space-y-2.5 rounded-md border border-border-subtle px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">{row.do_no}</span>
        {canWrite && (
          <button type="button" disabled={busy} onClick={onRemove}
            className="min-h-[32px] px-2 text-[11px] font-semibold text-ink-muted hover:text-ink-secondary disabled:opacity-60">
            Remove
          </button>
        )}
      </div>
      <div className={PAIR}>
        {text("do_no", "DO Number *", "DO-400-0002")}
        {date("do_date", "DO Date *")}
        {date("received_at", "Item Received Date *")}
        {text("received_by", "Received By", "Pick or type, e.g. Warehouse Team")}
      </div>
      <div className={PAIR}>
        <div className="flex flex-col gap-1.5">
          <span className={LABEL}>DO Attachment</span>
          {attachment}
        </div>
        <Field label="Remarks (Optional)">
          {canWrite ? (
            <textarea className={`${FIELD} min-h-[60px] resize-y`} rows={2} defaultValue={row.remarks ?? ""}
              placeholder="e.g. Item received in good condition" disabled={busy} key={`remarks:${row.remarks ?? ""}`}
              onBlur={(event) => onSave("remarks", event.target.value.trim())} />
          ) : (
            <span className="whitespace-pre-wrap text-[13px] text-ink-secondary">{row.remarks || "—"}</span>
          )}
        </Field>
      </div>
    </div>
  );
}

export function AddDoButton({ isAdding, canWrite, onAddingChange }: { isAdding: boolean; canWrite: boolean; onAddingChange: (isAdding: boolean) => void }): ReactElement | null {
  if (!canWrite || isAdding) return null;
  return (
    <button type="button" onClick={() => onAddingChange(true)}
      className="min-h-[32px] rounded-md border border-primary bg-surface px-3 py-1 text-[12px] font-semibold text-primary hover:opacity-90">
      + Add DO
    </button>
  );
}

export function ReturnDoList(props: ReturnDoListProps): ReactElement {
  const { caseId, returnDos, canWrite, isAdding, onAddingChange, renderAttachment, onChanged, onError, confirm, formatDate } = props;
  const [busy, setBusy] = useState(false);
  const [newDoNumber, setNewDoNumber] = useState("");

  const run = async (write: () => Promise<unknown>, failure: string): Promise<boolean> => {
    setBusy(true);
    try {
      await write();
      onChanged();
      return true;
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (row: ReturnDo) => (field: ReturnDoField, value: string) => {
    if ((row[field] ?? "") === value) return;
    if (field === "do_no" && !value) return onError("DO Number cannot be empty");
    void run(() => api.patch(returnDoPath(caseId, row.id), { [field]: value || null }), "Couldn't save the DO");
  };
  const remove = async (row: ReturnDo) => {
    if (!(await confirm(`Remove DO ${row.do_no}?`))) return;
    await run(() => api.del(returnDoPath(caseId, row.id)), "Couldn't remove the DO");
  };
  const add = async () => {
    const doNumber = newDoNumber.trim();
    if (!doNumber) return onError("Type the DO Number first");
    if (await run(() => api.post(returnDoPath(caseId, null), { do_no: doNumber }), "Couldn't add the DO")) {
      setNewDoNumber("");
      onAddingChange(false);
    }
  };

  return (
    <>
    <datalist id={RECEIVED_BY_LIST_ID}>
      {RECEIVED_BY_SUGGESTIONS.map((name) => <option key={name} value={name} />)}
    </datalist>
    <div className="space-y-3">
      {canWrite && isAdding && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border px-3 py-2.5">
          <div className="min-w-[200px] flex-1">
            <Field label="DO Number *">
              <input className={FIELD} value={newDoNumber} autoFocus placeholder="DO-400-0002"
                onChange={(event) => setNewDoNumber(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void add(); }} />
            </Field>
          </div>
          <button type="button" disabled={busy} onClick={() => void add()}
            className="min-h-[36px] rounded-md border border-primary bg-primary-soft px-3 py-1.5 text-[12px] font-semibold text-primary hover:opacity-90 disabled:opacity-60">
            Add DO
          </button>
          <button type="button" onClick={() => { onAddingChange(false); setNewDoNumber(""); }}
            className="min-h-[36px] rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary">
            Cancel
          </button>
        </div>
      )}
      {!returnDos.length && !isAdding && <p className="text-[12px] text-ink-muted">No supplier DO recorded yet.</p>}
      {returnDos.map((row) => (
        <ReturnDoRow key={row.id} row={row} canWrite={canWrite} busy={busy} attachment={renderAttachment(row.id)}
          onSave={save(row)} onRemove={() => void remove(row)} formatDate={formatDate} />
      ))}
    </div>
    </>
  );
}
