// ----------------------------------------------------------------------------
// ChangeApproverButton — a SUPER ADMIN (the * wildcard) choosing which desk
// approves an open SO amendment (owner 2026-09-25). Unlike the approver's own
// "not mine" handover it can go to any desk, more than once; the server still
// keeps a change the Purchase Order must follow with the Purchaser, and sends
// only a pure price / discount change to the Sales Director, and says why when
// it refuses.
//
// One component for the desktop job card, the quick view and the phone's
// amendment card, so who sees it and what it offers cannot drift.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { UserCog } from "lucide-react";
import { Button } from "../../components/Button";
import { useAuth } from "../../auth/AuthContext";
import { usePrompt } from "../../vendor/scm/components/PromptDialog";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { humanApiError } from "../../vendor/scm/lib/authed-fetch";
import { useChangeAmendmentLane } from "../../vendor/scm/lib/so-amendment-queries";
import { soAmendmentApprover, AMENDMENT_APPROVER_LABEL, SO_AMENDMENT_LANE_APPROVE_PERM } from "../../vendor/scm/lib/amendment-approver";

export type AmendmentLaneKey = "LINES" | "DELIVERY" | "PRICE";

export type ReassignableAmendment = {
  id: string;
  amendment_no?: string | number | null;
  status?: string | null;
  lane?: string | null;
};

const LANES = Object.keys(SO_AMENDMENT_LANE_APPROVE_PERM) as AmendmentLaneKey[];

export const CHANGE_APPROVER_NOTE_TOO_SHORT = "Say why the approver is changing — the new desk reads it.";

/** The desks an open lane row can be moved to, or [] when the caller may not. */
export function changeApproverTargets(a: ReassignableAmendment | null | undefined, isSuperAdmin: boolean): AmendmentLaneKey[] {
  if (!a || !isSuperAdmin || a.status !== "REQUESTED") return [];
  if (a.lane !== "LINES" && a.lane !== "DELIVERY" && a.lane !== "PRICE") return [];
  return LANES.filter((l) => l !== a.lane);
}

const deskOf = (lane: AmendmentLaneKey) => AMENDMENT_APPROVER_LABEL[soAmendmentApprover(lane)];

const plainError = (e: unknown): string => {
  const err = (e ?? {}) as { status?: number; body?: string; message?: string };
  if (typeof err.status === "number" && typeof err.body === "string") return humanApiError(err.status, err.body);
  return err.message ?? "Something went wrong. Please try again.";
};

export function ChangeApproverButton({ amendment, variant }: {
  amendment: ReassignableAmendment | null | undefined;
  variant: "desktop" | "mobile";
}) {
  const { can } = useAuth();
  const askPrompt = usePrompt();
  const notify = useNotify();
  const changeLane = useChangeAmendmentLane();
  const [open, setOpen] = useState(false);

  const targets = changeApproverTargets(amendment, can("*"));
  if (!amendment || targets.length === 0) return null;

  const handleMove = async (lane: AmendmentLaneKey) => {
    const desk = deskOf(lane);
    const note = await askPrompt({
      title: `Move amendment ${amendment.amendment_no ?? ""} to ${desk}?`.replace(/\s+/g, " ").trim(),
      body: `It will wait for ${desk} approval instead, still open. ${desk} and the person who raised it are told, with your note.`,
      placeholder: `e.g. this is a price change, ${desk} approves those`,
      multiline: true,
      confirmLabel: `Move to ${desk}`,
      validate: (v) => (v.trim().length < 5 ? CHANGE_APPROVER_NOTE_TOO_SHORT : null),
    });
    if (note == null) return;
    try {
      await changeLane.mutateAsync({ id: amendment.id, lane, note: note.trim() });
      setOpen(false);
      void notify({ title: `Moved to ${desk}`, body: `It is now waiting for ${desk} approval.` });
    } catch (e) {
      void notify({ title: `Not moved to ${desk}`, body: `${plainError(e)} Nothing was changed.`, tone: "error" });
    }
  };

  const busy = changeLane.isPending;
  if (variant === "mobile") {
    const btn = { border: "1px solid #d6d3cc", background: "#f4f2ee", color: "#3d3a33", fontFamily: "inherit", fontSize: 12, fontWeight: 700, borderRadius: 9, padding: "9px 11px", cursor: "pointer", opacity: busy ? 0.5 : 1 } as const;
    return (
      <>
        <button type="button" style={btn} disabled={busy} onClick={() => setOpen((o) => !o)}>Change approver (admin)</button>
        {open && targets.map((l) => (
          <button key={l} type="button" style={btn} disabled={busy} onClick={() => void handleMove(l)}>
            Move to {deskOf(l)}
          </button>
        ))}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="ghost" className="w-full" icon={<UserCog size={14} />} disabled={busy} onClick={() => setOpen((o) => !o)}>
        Change approver (admin)
      </Button>
      {open && targets.map((l) => (
        <Button key={l} variant="secondary" className="w-full" disabled={busy} onClick={() => void handleMove(l)}>
          Move to {deskOf(l)}
        </Button>
      ))}
    </div>
  );
}
