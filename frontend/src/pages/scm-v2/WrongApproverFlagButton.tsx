// ----------------------------------------------------------------------------
// WrongApproverFlagButton — the APPROVER, reviewing an SO amendment on their
// desk, saying "this is not mine to approve".
//
// Owner 2026-09-17: the flag used to sit in the requester's submit dialog, where
// nobody can judge it — a salesperson does not know which desk signs what. The
// approver reading the change does, so the flag lives on the job card, next to
// Approve / Reject. Option B (same day): it PASSES the request to the other desk
// — still REQUESTED, with the approver's note — unless the server refuses: a
// change the Purchase Order has to follow never leaves the Purchaser, and a
// request moves only once, so two desks cannot bounce it.
//
// One component for the desktop job card and the phone's amendment card, so the
// rule (who may flag, when) and the ask cannot drift between the two.
// ----------------------------------------------------------------------------

import { Flag } from "lucide-react";
import { Button } from "../../components/Button";
import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { humanApiError } from "../../vendor/scm/lib/authed-fetch";
import { useFlagAmendmentLane } from "../../vendor/scm/lib/so-amendment-queries";
import { soAmendmentApprover, AMENDMENT_APPROVER_LABEL } from "../../vendor/scm/lib/amendment-approver";

export type FlaggableAmendment = {
  id: string;
  amendment_no?: string | number | null;
  status?: string | null;
  lane?: string | null;
  lane_flag_note?: string | null;
};

export const WRONG_APPROVER_NOTE_TOO_SHORT =
  "Say why this is not yours to approve — that note is what the other desk reads.";

/* Only a lane row still waiting on its desk, only by someone who could sign it,
   and only once: a row that already carries a note was passed here. */
export function canFlagWrongApprover(a: FlaggableAmendment | null | undefined, canSign: boolean): boolean {
  if (!a || !canSign) return false;
  if (a.status !== "REQUESTED") return false;
  if (a.lane !== "LINES" && a.lane !== "DELIVERY") return false;
  return !(a.lane_flag_note ?? "").trim();
}

const plainError = (e: unknown): string => {
  const err = (e ?? {}) as { status?: number; body?: string; message?: string };
  if (typeof err.status === "number" && typeof err.body === "string") return humanApiError(err.status, err.body);
  return err.message ?? "Something went wrong. Please try again.";
};

export function WrongApproverFlagButton({ amendment, canSign, variant }: {
  amendment: FlaggableAmendment | null | undefined;
  /** The caller holds this row's own lane approval key. */
  canSign: boolean;
  variant: "desktop" | "mobile";
}) {
  const askPrompt = usePrompt();
  const notify = useNotify();
  const flagLane = useFlagAmendmentLane();

  /* The phone's amendment card has no section of its own for the saved note (the
     desktop job card does), so the note is shown here, to everyone. */
  const saved = (amendment?.lane_flag_note ?? "").trim();
  if (variant === "mobile" && saved) {
    return (
      <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#8a5a00" }}>
        Passed here by the other approver: "{saved}"
      </div>
    );
  }
  if (!amendment || !canFlagWrongApprover(amendment, canSign)) return null;

  const otherDesk = AMENDMENT_APPROVER_LABEL[soAmendmentApprover(amendment.lane === "LINES" ? "DELIVERY" : "LINES")];

  const handleFlag = async () => {
    const note = await askPrompt({
      title: `Pass amendment ${amendment.amendment_no ?? ""} to ${otherDesk}?`.replace(/\s+/g, " ").trim(),
      body: `Use this when the change is not yours to approve. It moves to the ${otherDesk} desk with your note `
        + "and leaves your queue; the person who raised it is told. It can be passed on only once.",
      placeholder: `e.g. this is a transport charge, ${otherDesk} approves those`,
      multiline: true,
      confirmLabel: `Pass to ${otherDesk}`,
      validate: (v) => (v.trim().length < 5 ? WRONG_APPROVER_NOTE_TOO_SHORT : null),
    });
    if (note == null) return;
    try {
      await flagLane.mutateAsync({ id: amendment.id, note: note.trim() });
      void notify({
        title: `Passed to ${otherDesk}`,
        body: `It is now waiting on the ${otherDesk} desk. They and the person who raised it have been told.`,
      });
    } catch (e) {
      void notify({
        title: `Not passed to ${otherDesk}`,
        body: `${plainError(e)} Nothing was changed.`,
        tone: "error",
      });
    }
  };

  const label = flagLane.isPending ? "Passing it on…" : "This is not mine to approve";
  if (variant === "mobile") {
    return (
      <button
        type="button"
        onClick={() => void handleFlag()}
        disabled={flagLane.isPending}
        style={{ border: "1px solid #e6d3a8", background: "#fbf3df", color: "#8a5a00", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: flagLane.isPending ? 0.5 : 1 }}
      >
        {label}
      </button>
    );
  }
  return (
    <Button
      variant="ghost"
      className="w-full"
      icon={<Flag size={14} />}
      onClick={() => void handleFlag()}
      disabled={flagLane.isPending}
    >
      {label}
    </Button>
  );
}
