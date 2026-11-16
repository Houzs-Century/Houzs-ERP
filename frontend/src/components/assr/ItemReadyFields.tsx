// Pending Item Ready (Operation Dept 2026-11-09): supplier DOs, QC inspection,
// the current supplier return trip and the QC report in one stage. The trip is
// read here and edited in Pickup / Return; the QC Result is that trip's own
// qc_result, so it is never typed twice. Kept out of ServiceCases.tsx, which is
// at its size ceiling.
import { useState, type ReactElement, type ReactNode } from "react";
import { ArrowLeftRight, FileText, Image, Search } from "lucide-react";
import { api } from "../../api/client";
import { formatDate } from "../../lib/utils";
import { InlineEdit } from "../InlineEdit";
import { ACTION_REQUIRED_OPTIONS, actionRequiredLabel, type ReturnDo } from "../../vendor/scm/lib/assr/item-ready";
import { currentRound, QC_RESULTS, tripTabLabel, type SupplierReturn } from "../../vendor/scm/lib/assr/returns";
import { CaseSection } from "./CaseSection";
import { AddDoButton, ReturnDoList } from "./ReturnDoList";

export interface ItemReadyCase {
  complaint_issue?: string | null;
  inspection_result?: string | null;
  supplier_service_note?: string | null;
  qc_inspected_at?: string | null;
  qc_by?: string | null;
  qc_findings?: string | null;
}

export interface ItemReadyFieldsProps {
  c: ItemReadyCase;
  caseId: number;
  trips: SupplierReturn[];
  returnDos: ReturnDo[];
  canWrite: boolean;
  patch: (body: Record<string, string | null>) => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
  confirm: (message: string) => boolean | Promise<boolean>;
  renderDoAttachment: (doId: number) => ReactNode;
  inspectionReport: ReactNode;
}

const LABEL = "text-[10px] font-semibold uppercase tracking-wider text-ink-muted";
const ACTION_VALUES = ACTION_REQUIRED_OPTIONS.map((option) => option.value);

function ReadOnly({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={LABEL}>{label}</span>
      <span className="min-h-[38px] whitespace-pre-wrap rounded-md border border-border-subtle bg-bg px-3 py-2 text-[13px] text-ink-secondary">{value}</span>
    </div>
  );
}

function TripQcResult({ caseId, trip, canWrite, onChanged, onError }: {
  caseId: number;
  trip: SupplierReturn | null;
  canWrite: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
}): ReactElement {
  if (!trip) return <ReadOnly label="QC Result" value="Add a supplier return first" />;
  const save = async (value: string) => {
    try {
      await api.patch(`/api/assr/${caseId}/supplier-returns/${trip.id}`, { qc_result: value || null });
      onChanged();
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : "Couldn't save the QC result");
    }
  };
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL}>QC Result *</span>
      <select
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary disabled:opacity-60"
        defaultValue={trip.qc_result ?? ""}
        key={`qc:${trip.id}:${trip.qc_result ?? ""}`}
        disabled={!canWrite}
        onChange={(event) => void save(event.target.value)}
      >
        <option value="">Pending QC</option>
        {QC_RESULTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function CurrentTripInfo({ trip, serviceNote }: { trip: SupplierReturn; serviceNote: string | null | undefined }): ReactElement {
  return (
    <>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <ReadOnly label="Sent to Supplier" value={formatDate(trip.pickup_at)} />
        <ReadOnly label="Back from Supplier (ETA)" value={formatDate(trip.expected_return_at)} />
        <ReadOnly label="Back from Supplier Date" value={formatDate(trip.returned_at)} />
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <ReadOnly label="Supplier" value={trip.creditor_name || trip.creditor_code || "—"} />
        <ReadOnly label="Reason for Return" value={trip.reason || "—"} />
        <ReadOnly label="Supplier Service Note" value={serviceNote || "—"} />
      </div>
      <p className="text-[11px] text-ink-muted">Edit these in Pickup / Return. They update here by themselves.</p>
    </>
  );
}

export function ItemReadyFields(props: ItemReadyFieldsProps): ReactElement {
  const { c, caseId, trips, returnDos, canWrite, patch, onChanged, onError, confirm } = props;
  const trip = currentRound(trips);
  const [isAddingDo, setIsAddingDo] = useState(false);
  return (
    <div className="space-y-3">
      <CaseSection title="Delivery Order (DO) Details" badge={returnDos.length > 1 ? `${returnDos.length} DOs` : null}
        icon={<FileText size={16} />} isCollapsible={false}
        action={<AddDoButton isAdding={isAddingDo} canWrite={canWrite} onAddingChange={setIsAddingDo} />}>
        <ReturnDoList caseId={caseId} returnDos={returnDos} canWrite={canWrite} isAdding={isAddingDo}
          onAddingChange={setIsAddingDo} renderAttachment={props.renderDoAttachment} onChanged={onChanged}
          onError={onError} confirm={confirm} formatDate={formatDate} />
      </CaseSection>

      <CaseSection title="QC Inspection Details" badge={null} icon={<Search size={16} />} action={null} isCollapsible>
        <div className="grid grid-cols-1 items-start gap-x-4 gap-y-3 sm:grid-cols-2">
          <InlineEdit label="QC Inspection Date *" type="date" value={c.qc_inspected_at}
            onSave={(value) => patch({ qc_inspected_at: value })} />
          <InlineEdit label="QC By *" value={c.qc_by} placeholder="Who did the QC, e.g. Farra"
            onSave={(value) => patch({ qc_by: value?.trim() || null })} />
          <TripQcResult caseId={caseId} trip={trip} canWrite={canWrite} onChanged={onChanged} onError={onError} />
          <InlineEdit label="Action Required *" value={c.inspection_result} options={ACTION_VALUES}
            optionLabel={actionRequiredLabel} onSave={(value) => patch({ inspection_result: value })} />
          <div className="sm:col-span-2">
            <ReadOnly label="Original Defect / Issue" value={trip?.reason || c.complaint_issue || "—"} />
          </div>
          <InlineEdit label="Supplier Rectification" textarea value={c.supplier_service_note}
            placeholder="What the supplier did to fix it" onSave={(value) => patch({ supplier_service_note: value })} />
          <InlineEdit label="QC Findings" textarea value={c.qc_findings}
            placeholder="What QC found on the returned item" onSave={(value) => patch({ qc_findings: value })} />
        </div>
      </CaseSection>

      <CaseSection title="Supplier Return Info (Current Trip)" badge={trip ? tripTabLabel(trip.round_no) : null}
        icon={<ArrowLeftRight size={16} />} action={null} isCollapsible>
        {trip
          ? <CurrentTripInfo trip={trip} serviceNote={c.supplier_service_note} />
          : <p className="text-[12px] text-ink-muted">No supplier return recorded yet.</p>}
      </CaseSection>

      <CaseSection title="QC Inspection Report" badge={null} icon={<Image size={16} />} action={null} isCollapsible>
        {props.inspectionReport}
      </CaseSection>
    </div>
  );
}
