/**
 * Pending-invitations manager for the mobile Members list — the phone
 * counterpart of the desktop Team.tsx invitations table (owner 2026-07-29:
 * "移动端也要能管理邀请"). A collapsed accordion card (HistoryCard idiom):
 * the header always shows the live count + an expired badge; the body lists
 * every open invite with Resend / Copy Link / Revoke plus a bulk
 * revoke-expired, all gated on users.manage exactly like the desktop.
 * Endpoints and expiry/link rules are shared via lib/invitations — one
 * logic layer, two presentations.
 */
import { useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { relativeTime } from "../lib/utils";
import { inviteExpiry, inviteLink } from "../lib/invitations";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import type { Invitation } from "../types";

const SMALL_BTN: CSSProperties = {
  border: "1px solid #bcdcd7",
  background: "#e1efed",
  color: "#16695f",
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 8,
  padding: "5px 11px",
};

const DANGER_BTN: CSSProperties = {
  border: "1.5px solid #f0d4d4",
  background: "#fff",
  color: "#b23a3a",
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 8,
  padding: "5px 11px",
};

function StatusBadge({ inv }: { inv: Invitation }) {
  const s = inviteExpiry(inv);
  if (s === "expired") return <span className="badge b-red">Expired</span>;
  if (s === "expiring") return <span className="badge b-amber">Expiring soon</span>;
  return <span className="badge b-grey">Pending</span>;
}

export function MobileInvitations() {
  const { can } = useAuth();
  const canManage = can("users.manage");
  const confirm = useConfirm();
  const notify = useNotify();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  /** Row id with a mutation in flight; -1 = the bulk revoke. */
  const [busyId, setBusyId] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["mobile-invitations"],
    queryFn: () => api.get<{ invitations: Invitation[] }>("/api/users/invitations"),
    staleTime: 30_000,
  });
  const invites = q.data?.invitations ?? [];
  const expired = invites.filter((inv) => inviteExpiry(inv) === "expired");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["mobile-invitations"] });
    // Revoking also deletes the placeholder invited user — refresh the list.
    void qc.invalidateQueries({ queryKey: ["mobile-module"] });
  };

  async function doResend(inv: Invitation) {
    setBusyId(inv.id);
    try {
      const res = await api.post<{ ok: boolean; email_sent: boolean; email_status?: string }>(
        `/api/users/invitations/${inv.id}/resend`,
      );
      if (res.email_sent) {
        await notify({ title: "Invitation emailed", body: inv.email });
      } else {
        await notify({
          title: "Email not sent",
          body: `${res.email_status || "Check Settings, Email"} — use Copy Link instead`,
          tone: "error",
        });
      }
      refresh();
    } catch (e) {
      await notify({
        title: "Resend failed",
        body: e instanceof Error ? e.message : "Try again.",
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function doCopy(inv: Invitation) {
    const link = inviteLink(inv);
    let copied = false;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      copied = false;
    }
    await notify(
      copied
        ? { title: "Invite link copied", body: link }
        : { title: "Couldn't access clipboard", body: link, tone: "error" },
    );
  }

  async function doRevoke(inv: Invitation) {
    const ok = await confirm({
      title: "Revoke invitation?",
      body: `${inv.email} will no longer be able to join with this link.`,
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    setBusyId(inv.id);
    try {
      await api.del(`/api/users/invitations/${inv.id}`);
      refresh();
    } catch (e) {
      await notify({
        title: "Revoke failed",
        body: e instanceof Error ? e.message : "Try again.",
        tone: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function doRevokeExpired() {
    if (expired.length === 0) return;
    const ok = await confirm({
      title: `Revoke ${expired.length} expired invitation${expired.length === 1 ? "" : "s"}?`,
      body: "This can't be undone.",
      confirmLabel: "Revoke all",
      danger: true,
    });
    if (!ok) return;
    setBusyId(-1);
    try {
      await Promise.all(expired.map((inv) => api.del(`/api/users/invitations/${inv.id}`)));
    } catch (e) {
      await notify({
        title: "Some revokes failed",
        body: e instanceof Error ? e.message : "Try again.",
        tone: "error",
      });
    } finally {
      setBusyId(null);
      refresh();
    }
  }

  const busy = busyId !== null;

  return (
    <div className="card" style={{ marginBottom: 11 }}>
      <div
        className="card-h"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        style={{ cursor: "pointer", userSelect: "none" }}
        aria-expanded={open}
      >
        <span className="card-t">Pending Invitations</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className="card-sub">{q.isLoading ? "…" : invites.length}</span>
          {expired.length > 0 && <span className="badge b-red">{expired.length} expired</span>}
          <span
            aria-hidden
            style={{
              transform: open ? "rotate(90deg)" : "none",
              transition: "transform .15s",
              color: "var(--ink3, #767b6e)",
            }}
          >
            ›
          </span>
        </span>
      </div>

      {open && (
        <div style={{ padding: "2px 13px 12px" }}>
          {q.isLoading && <div className="ph" style={{ height: 40, borderRadius: 8, marginTop: 8 }} />}
          {!q.isLoading && !!q.error && (
            <div className="empty-s" style={{ padding: "10px 0" }}>
              Couldn't load invitations. Pull to refresh to try again.
            </div>
          )}
          {!q.isLoading && !q.error && invites.length === 0 && (
            <div className="empty-s" style={{ padding: "10px 0" }}>
              No pending invitations.
            </div>
          )}

          {canManage && expired.length > 0 && (
            <button
              type="button"
              onClick={doRevokeExpired}
              disabled={busy}
              style={{
                ...DANGER_BTN,
                width: "100%",
                padding: "8px 11px",
                margin: "8px 0 10px",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busyId === -1 ? "Revoking…" : `Revoke ${expired.length} expired`}
            </button>
          )}

          {invites.map((inv) => (
            <div
              key={inv.id}
              style={{
                borderTop: "1px solid var(--line2)",
                padding: "10px 0",
                opacity: inviteExpiry(inv) === "expired" ? 0.65 : 1,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {inv.email}
                </span>
                <StatusBadge inv={inv} />
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 4,
                  fontSize: 11.5,
                  color: "var(--ink3, #767b6e)",
                }}
              >
                {inv.role_name && <span className="badge b-brand">{inv.role_name}</span>}
                <span>expires {relativeTime(inv.expires_at)}</span>
                {inv.email_status === "sent" ? (
                  <span>· emailed{inv.emailed_at ? ` ${relativeTime(inv.emailed_at)}` : ""}</span>
                ) : inv.email_status ? (
                  <span className="badge b-amber">email not sent</span>
                ) : null}
              </div>
              {canManage && (
                <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => doResend(inv)}
                    style={{ ...SMALL_BTN, opacity: busy ? 0.6 : 1 }}
                  >
                    {busyId === inv.id ? "Working…" : "Resend"}
                  </button>
                  <button type="button" onClick={() => doCopy(inv)} style={SMALL_BTN}>
                    Copy Link
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => doRevoke(inv)}
                    style={{ ...DANGER_BTN, marginLeft: "auto", opacity: busy ? 0.6 : 1 }}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
