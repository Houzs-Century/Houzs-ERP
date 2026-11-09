// Verification step findings (HC-0133): what the inspection found and did,
// the next action, and who the case is pending with. Sits under the root cause
// in the Verification card. Kept out of ServiceCases.tsx, which is at its size
// ceiling.
import { InlineEdit } from "../InlineEdit";

type Row = {
  inspection_findings?: string | null;
  next_action?: string | null;
  pending_with?: string | null;
};

export function VerificationFindingsFields({ c, patch }: { c: Row; patch: (body: Record<string, string | null>) => Promise<void> }) {
  return (
    <>
      <InlineEdit
        label="Inspection Findings / Action Taken"
        textarea
        value={c.inspection_findings}
        placeholder="What did the technician inspect? What was found? What action was taken?"
        onSave={(v) => patch({ inspection_findings: v })}
      />
      <div className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2">
        <InlineEdit
          label="Next Action"
          textarea
          value={c.next_action}
          placeholder="Example: Repair on-site / Pickup for service / Awaiting supplier confirmation"
          onSave={(v) => patch({ next_action: v })}
        />
        <InlineEdit
          label="Pending With"
          value={c.pending_with}
          placeholder="Example: Logistic Team / Supplier / Customer"
          onSave={(v) => patch({ pending_with: v })}
        />
      </div>
    </>
  );
}
