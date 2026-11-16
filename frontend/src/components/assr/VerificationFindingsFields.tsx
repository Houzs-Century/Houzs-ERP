// Verification step findings (HC-0133): what the inspection found and did,
// the next action, and who the case is pending with. Sits under the root cause
// in the Verification card. Kept out of ServiceCases.tsx, which is at its size
// ceiling.
import { ChevronsRight, ClipboardList, Users } from "lucide-react";
import { InlineEdit } from "../InlineEdit";
import { CaseSection } from "./CaseSection";

type Row = {
  inspection_findings?: string | null;
  next_action?: string | null;
  pending_with?: string | null;
};

export function VerificationFindingsFields({ c, patch }: { c: Row; patch: (body: Record<string, string | null>) => Promise<void> }) {
  return (
    <>
      <CaseSection title="Inspection Findings / Action Taken" badge={null} icon={<ClipboardList size={16} />} action={null} isCollapsible={false}>
        <InlineEdit
          label="Inspection Findings / Action Taken"
          isLabelHidden
          textarea
          value={c.inspection_findings}
          placeholder="What did the technician inspect? What was found? What action was taken?"
          onSave={(v) => patch({ inspection_findings: v })}
        />
      </CaseSection>
      <div className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2">
        <CaseSection title="Next Action" badge={null} icon={<ChevronsRight size={16} />} action={null} isCollapsible={false}>
          <InlineEdit
            label="Next Action"
            isLabelHidden
            textarea
            value={c.next_action}
            placeholder="Example: Repair on-site / Pickup for service / Awaiting supplier confirmation"
            onSave={(v) => patch({ next_action: v })}
          />
        </CaseSection>
        <CaseSection title="Pending With" badge={null} icon={<Users size={16} />} action={null} isCollapsible={false}>
          <InlineEdit
            label="Pending With"
            isLabelHidden
            textarea
            value={c.pending_with}
            placeholder="Example: Logistic Team / Supplier / Customer"
            onSave={(v) => patch({ pending_with: v })}
          />
        </CaseSection>
      </div>
    </>
  );
}
