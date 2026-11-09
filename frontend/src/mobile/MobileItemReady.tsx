// Pending Item Ready on the phone (Operation Dept 2026-11-09): the same four
// sections as desktop (ItemReadyFields), laid out as one column of cards. The
// current trip is read-only here and edited in Pickup / Return; its QC Result is
// the trip's own qc_result. Lives outside MobileServiceCase.tsx (size ceiling).
import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { api } from "../api/client";
import { DateField } from "../vendor/scm/components/DateField";
import { fmtDate } from "@2990s/shared";
import { ACTION_REQUIRED_OPTIONS, RECEIVED_BY_SUGGESTIONS, returnDoPath, type ReturnDo } from "../vendor/scm/lib/assr/item-ready";
import { currentRound, QC_RESULTS, tripTabLabel, type SupplierReturn } from "../vendor/scm/lib/assr/returns";
import { get, type Any } from "./assr-case-fields";
import { MobileSectionHead } from "./MobileFactoryTrips";

const INK = "#11140f";
const MUTED = "#767b6e";
const LINE = "#d6d9d2";

const lbl: CSSProperties = { fontSize: 11, color: MUTED, display: "block", margin: "8px 0 3px" };
const inp: CSSProperties = { width: "100%", boxSizing: "border-box", padding: "10px", border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 16, fontFamily: "inherit", background: "#fff" };
const pair: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 };
const card: CSSProperties = { border: `1px solid ${LINE}`, borderRadius: 10, padding: "8px 10px 10px", marginTop: 8 };
const readOnly: CSSProperties = { ...inp, background: "#f4f6f3", color: INK, minHeight: 42, whiteSpace: "pre-wrap" };

export interface MobileItemReadyProps {
  c: Any;
  caseId: number;
  trips: SupplierReturn[];
  returnDos: ReturnDo[];
  busy: boolean;
  disabled: boolean;
  runWrite: (write: () => Promise<void>, failTitle: string) => void | Promise<void>;
  renderDoFiles: (doId: number) => ReactNode;
  report: ReactNode;
}

type Write = MobileItemReadyProps["runWrite"];

const RECEIVED_BY_LIST_ID = "m-assr-received-by-suggestions";

function TextInput({ label, value, placeholder, isMultiline, disabled, onSave, suggestionListId }: {
  label: string;
  value: unknown;
  placeholder: string;
  isMultiline: boolean;
  disabled: boolean;
  onSave: (value: string | null) => void;
  suggestionListId?: string;
}): ReactElement {
  const saved = value ? String(value) : "";
  const save = (next: string) => { if (next.trim() !== saved) onSave(next.trim() || null); };
  return (
    <div>
      <label style={lbl}>{label}</label>
      {isMultiline ? (
        <textarea style={inp} rows={2} defaultValue={saved} placeholder={placeholder} disabled={disabled} key={saved} onBlur={(event) => save(event.target.value)} />
      ) : (
        <input style={inp} defaultValue={saved} placeholder={placeholder} disabled={disabled} key={saved} list={suggestionListId} onBlur={(event) => save(event.target.value)} />
      )}
    </div>
  );
}

function DateInput({ label, value, disabled, onSave }: { label: string; value: unknown; disabled: boolean; onSave: (iso: string | null) => void }): ReactElement {
  return (
    <div>
      <label style={lbl}>{label}</label>
      <DateField value={value ? String(value) : ""} onChange={(iso) => onSave(iso || null)} disabled={disabled} fullWidth aria-label={label} />
    </div>
  );
}

function DoCard({ row, caseId, disabled, runWrite, files }: { row: ReturnDo; caseId: number; disabled: boolean; runWrite: Write; files: ReactNode }): ReactElement {
  const save = (field: keyof ReturnDo) => (value: string | null) => {
    if (field === "do_no" && !value) return;
    void runWrite(async () => { await api.patch(returnDoPath(caseId, row.id), { [field]: value }); }, "Couldn't save the DO");
  };
  const remove = () => void runWrite(async () => { await api.del(returnDoPath(caseId, row.id)); }, "Couldn't remove the DO");
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: INK }}>{row.do_no}</span>
        {!disabled ? <button className="tinybtn" onClick={remove}>Remove</button> : null}
      </div>
      <TextInput label="DO Number *" value={row.do_no} placeholder="DO-400-0002" isMultiline={false} disabled={disabled} onSave={save("do_no")} />
      <div style={pair}>
        <DateInput label="DO Date *" value={row.do_date} disabled={disabled} onSave={save("do_date")} />
        <DateInput label="Item Received *" value={row.received_at} disabled={disabled} onSave={save("received_at")} />
      </div>
      <TextInput label="Received By" value={row.received_by} placeholder="Pick or type, e.g. Warehouse Team" isMultiline={false} disabled={disabled} onSave={save("received_by")} suggestionListId={RECEIVED_BY_LIST_ID} />
      <TextInput label="Remarks (Optional)" value={row.remarks} placeholder="e.g. Item received in good condition" isMultiline disabled={disabled} onSave={save("remarks")} />
      {files}
    </div>
  );
}

function AddDo({ caseId, busy, runWrite }: { caseId: number; busy: boolean; runWrite: Write }): ReactElement {
  const [isAdding, setIsAdding] = useState(false);
  const [doNumber, setDoNumber] = useState("");
  const add = () => {
    const value = doNumber.trim();
    if (!value) return;
    setDoNumber(""); setIsAdding(false);
    void runWrite(async () => { await api.post(returnDoPath(caseId, null), { do_no: value }); }, "Couldn't add the DO");
  };
  if (!isAdding) return <button className="tinybtn" style={{ marginTop: 10 }} disabled={busy} onClick={() => setIsAdding(true)}>+ Add DO</button>;
  return (
    <div style={{ marginTop: 10 }}>
      <input style={inp} value={doNumber} autoFocus placeholder="DO Number, e.g. DO-400-0002" onChange={(event) => setDoNumber(event.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="tinybtn" disabled={busy || !doNumber.trim()} onClick={add}>Add DO</button>
        <button className="tinybtn" onClick={() => { setIsAdding(false); setDoNumber(""); }}>Cancel</button>
      </div>
    </div>
  );
}

function TripSummary({ trip, serviceNote }: { trip: SupplierReturn; serviceNote: string }): ReactElement {
  const rows: Array<[string, string]> = [
    ["Sent to Supplier", fmtDate(trip.pickup_at) || "—"],
    ["Back from Supplier (ETA)", fmtDate(trip.expected_return_at) || "—"],
    ["Back from Supplier Date", fmtDate(trip.returned_at) || "—"],
    ["Supplier", trip.creditor_name || trip.creditor_code || "—"],
    ["Reason for Return", trip.reason || "—"],
    ["Supplier Service Note", serviceNote || "—"],
  ];
  return (
    <div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: `1px solid ${LINE}`, fontSize: 13 }}>
          <span style={{ color: MUTED }}>{label}</span>
          <span style={{ color: INK, textAlign: "right" }}>{value}</span>
        </div>
      ))}
      <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Edit these in Pickup / Return.</div>
    </div>
  );
}

export function MobileItemReady({ c, caseId, trips, returnDos, busy, disabled, runWrite, renderDoFiles, report }: MobileItemReadyProps): ReactElement {
  const trip = currentRound(trips);
  const off = disabled || busy;
  const patchCase = (body: Record<string, string | null>) =>
    void runWrite(async () => { await api.patch(`/api/assr/${caseId}`, body); }, "Couldn't save");
  const saveTripQc = (value: string) => {
    if (!trip) return;
    void runWrite(async () => { await api.patch(`/api/assr/${caseId}/supplier-returns/${trip.id}`, { qc_result: value || null }); }, "Couldn't save the QC result");
  };
  const defect = trip?.reason || get(c, "complaintIssue", "complaint_issue") || "—";

  return (
    <div>
      <datalist id={RECEIVED_BY_LIST_ID}>
        {RECEIVED_BY_SUGGESTIONS.map((name) => <option key={name} value={name} />)}
      </datalist>
      <MobileSectionHead title="Delivery Order (DO)" badge={returnDos.length > 1 ? `${returnDos.length} DOs` : null} />
      {!disabled ? <AddDo caseId={caseId} busy={busy} runWrite={runWrite} /> : null}
      {!returnDos.length ? <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>No supplier DO recorded yet.</div> : null}
      {returnDos.map((row) => <DoCard key={row.id} row={row} caseId={caseId} disabled={off} runWrite={runWrite} files={renderDoFiles(row.id)} />)}

      <MobileSectionHead title="QC Inspection" badge={null} />
      <div style={pair}>
        <DateInput label="QC Inspection Date *" value={get(c, "qcInspectedAt", "qc_inspected_at")} disabled={off} onSave={(iso) => patchCase({ qc_inspected_at: iso })} />
        <TextInput label="QC By *" value={get(c, "qcBy", "qc_by")} placeholder="e.g. Farra" isMultiline={false} disabled={off} onSave={(value) => patchCase({ qc_by: value })} />
      </div>
      <label style={lbl}>QC Result *</label>
      {trip ? (
        <select style={inp} value={trip.qc_result ?? ""} disabled={off} onChange={(event) => saveTripQc(event.target.value)}>
          <option value="">Pending QC</option>
          {QC_RESULTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : <div style={readOnly}>Add a supplier return first</div>}
      <label style={lbl}>Original Defect / Issue</label>
      <div style={readOnly}>{String(defect)}</div>
      <TextInput label="Supplier Rectification" value={get(c, "supplierServiceNote", "supplier_service_note")} placeholder="What the supplier did to fix it" isMultiline disabled={off} onSave={(value) => patchCase({ supplier_service_note: value })} />
      <TextInput label="QC Findings" value={get(c, "qcFindings", "qc_findings")} placeholder="What QC found on the returned item" isMultiline disabled={off} onSave={(value) => patchCase({ qc_findings: value })} />
      <label style={lbl}>Action Required *</label>
      <select style={inp} value={String(get(c, "inspectionResult", "inspection_result") ?? "")} disabled={off} onChange={(event) => patchCase({ inspection_result: event.target.value || null })}>
        <option value="">Not decided</option>
        {ACTION_REQUIRED_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>

      <MobileSectionHead title="Supplier Return (Current Trip)" badge={trip ? tripTabLabel(trip.round_no) : null} />
      {trip
        ? <TripSummary trip={trip} serviceNote={String(get(c, "supplierServiceNote", "supplier_service_note") ?? "")} />
        : <div style={{ fontSize: 12, color: MUTED }}>No supplier return recorded yet.</div>}

      <MobileSectionHead title="QC Inspection Report" badge={null} />
      {report}
    </div>
  );
}
