import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { usePrompt } from "../vendor/scm/components/PromptDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { MobileFieldPin } from "./MobileFieldPin";
import {
  requirePasswordChange,
  requirePasswordChangeConfirmText,
  requirePasswordChangeDoneText,
} from "../lib/requirePasswordChange";


const str = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return "";
};

function Eyebrow({ children }: { children: string }) {
  return <div className="ey" style={{ color: "var(--hz-c-ink-muted)", margin: "4px 2px 6px" }}>{children}</div>;
}

type MemberRow = { id?: unknown; email?: unknown; status?: unknown } | null | undefined;

export function MemberAccountActions({ row, onDone }: { row: MemberRow; onDone: () => void }) {
  const { can } = useAuth();
  const notify = useNotify();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [busy, setBusy] = useState<null | "reset" | "resend" | "setpw" | "require">(null);
  const id = str(row?.id);
  const email = str(row?.email);
  const status = String(row?.status ?? "").toLowerCase();
  if (!can("users.manage") || !id) return null;

  const copyLink = async (link: string): Promise<boolean> => {
    if (!link) return false;
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false;
    }
  };

  const resendInvite = async () => {
    setBusy("resend");
    try {
      const res = await api.post<{
        ok: boolean;
        invite_url?: string;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${id}/resend-invite`);
      const copied = await copyLink(res.invite_url ?? "");
      if (res.email_sent) {
        await notify({ title: "Invitation sent", body: copied ? `Emailed to ${email} — the invite link is also copied.` : `Emailed to ${email}.` });
      } else if (copied) {
        await notify({ title: "Invite link copied", body: `Email not sent (${res.email_status || "check Settings, Email"}) — paste the copied link to the member.` });
      } else {
        await notify({ title: "Couldn't send", body: `Email not sent (${res.email_status || "check Settings, Email"}).` });
      }
      onDone();
    } catch (e) {
      await notify({ title: "Couldn't resend", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async () => {
    if (!(await confirm({ title: "Send reset link?", body: `Email a password reset link to ${email}? Nothing changes until they click it — their password and active sessions keep working. The link expires in 1 hour.`, confirmLabel: "Send link" }))) return;
    setBusy("reset");
    try {
      const res = await api.post<{
        ok: boolean;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${id}/reset-password`);
      if (res.email_sent) {
        await notify({ title: "Reset link sent", body: `Emailed to ${email} — expires in 1 hour.` });
      } else {
        await notify({ title: "Couldn't send", body: `Email not sent (${res.email_status || "check Settings, Email"}). Nothing was changed on the account.` });
      }
    } catch (e) {
      await notify({ title: "Couldn't send", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const setNewPassword = async () => {
    const pw = await prompt({
      title: "Set a new password",
      body: `New password for ${email}. They sign in with their email and this password — it is not emailed, so tell it to them directly.`,
      placeholder: "At least 12 characters",
      confirmLabel: "Set password",
      validate: (v) => (v.trim().length < 12 ? "Password must be at least 12 characters." : null),
    });
    if (pw == null) return;
    setBusy("setpw");
    try {
      await api.patch(`/api/users/${id}`, { password: pw.trim() });
      await notify({ title: "Password set", body: `${email} can now sign in with the new password.` });
    } catch (e) {
      await notify({ title: "Couldn't set password", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const requireNewPassword = async () => {
    if (!(await confirm({ title: "Require password change?", body: requirePasswordChangeConfirmText(email), confirmLabel: "Require change" }))) return;
    setBusy("require");
    try {
      const ended = await requirePasswordChange(id);
      await notify({ title: "Password change required", body: requirePasswordChangeDoneText(email, ended) });
    } catch (e) {
      await notify({ title: "Couldn't require a change", body: e instanceof Error ? e.message : "Please try again." });
    } finally {
      setBusy(null);
    }
  };

  const isInvited = status === "invited";
  return (
    <>
      <Eyebrow>Actions</Eyebrow>
      <div style={{ display: "grid", gap: 8, marginBottom: 13 }}>
        {isInvited ? (
          <button className="btn" disabled={busy !== null} onClick={resendInvite} style={{ opacity: busy !== null ? 0.6 : 1 }}>
            {busy === "resend" ? "Working…" : "Resend invitation"}
          </button>
        ) : (
          <>
            <button className="btn" disabled={busy !== null} onClick={setNewPassword} style={{ opacity: busy !== null ? 0.6 : 1 }}>
              {busy === "setpw" ? "Working…" : "Set new password"}
            </button>
            <button className="btn" disabled={busy !== null} onClick={resetPassword} style={{ opacity: busy !== null ? 0.6 : 1 }}>
              {busy === "reset" ? "Working…" : "Send reset link"}
            </button>
            <button className="btn" disabled={busy !== null} onClick={requireNewPassword} style={{ opacity: busy !== null ? 0.6 : 1 }}>
              {busy === "require" ? "Working…" : "Require password change"}
            </button>
          </>
        )}
      </div>
      {!isInvited && Number(id) > 0 && <MobileFieldPin userId={Number(id)} memberName={email || `member ${id}`} />}
    </>
  );
}
