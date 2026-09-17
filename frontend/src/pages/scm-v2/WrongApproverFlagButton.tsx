// ----------------------------------------------------------------------------
// WrongApproverFlagButton — the APPROVER, reviewing an SO amendment on their
// desk, saying "this is not mine to approve".
//
// Owner 2026-09-17: the flag used to sit in the requester's submit dialog, where
// nobody can judge it — a salesperson does not know which desk signs what. The
// approver reading the change does, so the flag lives on the job card, next to
// Approve / Reject. It is a NOTE, not a transition: the row stays REQUESTED on
// the lane the rule gave it, the other desk and the requester are told, and an
// administrator moves it with the relane workflow.
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
  "Say which desk should approve it, and why — that note is what they read.";

/* Only a lane row still waiting on its desk, only by someone who could sign it,
   and only once: the saved note is what the other desk reads. */
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
        Flagged as the wrong approver: "{saved}" It stays here until an administrator moves it.
      </div>
    );
  }
  if (!amendment || !canFlagWrongApprover(amendment, canSign)) return null;

  const otherDesk = AMENDMENT_APPROVER_LABEL[soAmendmentApprover(amendment.lane === "LINES" ? "DELIVERY" : "LINES")];

  const handleFlag = async () => {
    const note = await askPrompt({
      title: `Flag amendment ${amendment.amendment_no ?? ""} as the wrong approver?`.replace(/\s+/g, " ").trim(),
      body: "Use this when the change is not yours to approve. The request stays on your desk for now: "
        + `your note is saved on it, the ${otherDesk} desk and the person who raised it are told, `
        + "and an administrator can move it.",
      placeholder: `e.g. this is a transport charge, ${otherDesk} approves those`,
      multiline: true,
      confirmLabel: "Flag wrong approver",
      validate: (v) => (v.trim().length < 5 ? WRONG_APPROVER_NOTE_TOO_SHORT : null),
    });
    if (note == null) return;
    try {
      await flagLane.mutateAsync({ id: amendment.id, note: note.trim() });
      void notify({
        title: "Flagged as the wrong approver",
        body: `The ${otherDesk} desk and the person who raised it have been told. It stays here until an administrator moves it.`,
      });
    } catch (e) {
      void notify({
        title: "Could not flag this amendment",
        body: `${plainError(e)} Nothing was changed — please try again.`,
        tone: "error",
      });
    }
  };

  const label = flagLane.isPending ? "Flagging…" : "This is not mine to approve";
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
