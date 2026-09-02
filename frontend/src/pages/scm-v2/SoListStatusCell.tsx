/* The Sales Order list's Status cell — its own module because the list file is
   at its size ceiling and may only shrink (docs/repo-hygiene.md), and because a
   cell that has to explain a disagreement is more than a pill.

   It renders THE ONE RULE (soRowStatus -> soStatusDisplay), the same one the SO
   detail's editor renders, so this cell and the Delivered column beside it can
   no longer answer "has this gone out?" two different ways.

   When the derived answer disagrees with the STORED status, the disagreement is
   SHOWN, never quietly resolved: the stored value is what the tab strip counts
   this row under (a server-side aggregate over that column), so rendering only
   the derived answer would file a row under a tab its own pill contradicts.
   docs/bugs/0619-one-row-answered-has-this-gone-out-two-different-ways.md */
import { StatusWithHold, type HoldFields } from "../../vendor/scm/components/HoldChip";
import { soStatusDisplay } from "../../vendor/scm/lib/so-status";
import { soRowStatus, type SoRowStatusFields } from "./so-list-status";

export function SoListStatusCell({ row }: { row: SoRowStatusFields & HoldFields }) {
  const st = soRowStatus(row, soStatusDisplay);
  /* mig 0324 — the Hold marker sits BESIDE the real status pill. */
  return (
    <span className="inline-flex items-center gap-1">
      <StatusWithHold tone={st.tone} label={st.label} row={row} />
      {st.storedLabel && (
        <span
          title={`This order's own delivery records say ${st.label}, but its stored status is still ${st.storedLabel} — which is the tab it is counted under. The stored status is only rewritten when a delivery order changes through the app, so an imported or scripted delivery leaves it behind.`}
          className="rounded border border-warning-text/40 bg-warning-bg px-1 text-[10px] font-semibold text-warning-text"
        >
          {st.storedLabel}
        </span>
      )}
    </span>
  );
}
