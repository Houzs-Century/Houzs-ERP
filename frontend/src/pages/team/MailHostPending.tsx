import { useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { Button } from "../../components/Button";
import { Eyebrow } from "./teamShared";
import { fmtDate } from "../../vendor/shared/format";

type Pending = {
  id: string;
  address: string;
  name: string;
  createdAt: string | null;
  userId: number | null;
  requestedDepartment: { id: number; name: string } | null;
};

/* DEV-03 R2: a personal address the ERP gave a new member receives mail only
 * once it is added in Google Workspace, as an alias of an account Mail Center
 * already syncs. Each row leaves the list when an admin marks it, or by itself
 * when the first mail to it arrives. A member who claimed their own address
 * with no department yet (HC-0157 A) asked for one; putting them in it goes
 * through the member screen's own route, as a department opens its mailboxes. */
export function MailHostPending() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const { data, reload } = useQuery<Pending[]>("/api/mail-center/mail-host/pending", () =>
    api.get("/api/mail-center/mail-host/pending"),
  );
  const rows = data ?? [];
  if (rows.length === 0) return null;

  async function confirm(row: Pending) {
    setBusy(row.id);
    try {
      await api.post(`/api/mail-center/mail-host/${encodeURIComponent(row.id)}/confirm`, {});
      toast.success(`${row.address} marked as added`);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not mark it");
    } finally {
      setBusy(null);
    }
  }

  /* Owner 2026-11-24: an address nobody needs leaves the list without going to Google. It was never added
   * there, so it frees no alias and does not join the "still in Google" list; it can be turned on again. */
  async function turnOff(row: Pending) {
    setBusy(row.id);
    try {
      await api.patch(`/api/mail-center/addresses/${encodeURIComponent(row.id)}`, { active: false });
      toast.success(`${row.address} turned off`);
      setConfirmOff(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not turn it off");
    } finally {
      setBusy(null);
    }
  }

  async function placeInDepartment(row: Pending) {
    if (row.userId == null || !row.requestedDepartment) return;
    setBusy(row.id);
    try {
      await api.patch(`/api/users/${row.userId}`, { department_id: row.requestedDepartment.id });
      toast.success(`${row.name || row.address} is now in ${row.requestedDepartment.name}`);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not set the department");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-accent bg-warning-bg p-4 lg:col-span-2">
      <Eyebrow>Waiting to be added in Google Workspace ({rows.length})</Eyebrow>
      <p className="mb-2 mt-1 text-[12px] leading-relaxed text-warning-text">
        These members can already send from their address, but mail to it is not received yet. In Google Admin, add each
        address as an alias of an account Mail Center already reads (for example hello@), then mark it added.
      </p>
      <div className="flex flex-col divide-y divide-border/60">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12.5px]">
            <span>
              <span className="font-mono text-ink">{r.address}</span>
              <span className="text-ink-secondary">
                {r.name ? ` · ${r.name}` : ""}
                {r.createdAt ? ` · since ${fmtDate(r.createdAt)}` : ""}
                {r.requestedDepartment ? ` · asks to be in ${r.requestedDepartment.name}` : ""}
              </span>
            </span>
            <span className="flex gap-2">
              {r.requestedDepartment && (
                <Button variant="secondary" disabled={busy === r.id} onClick={() => void placeInDepartment(r)}>
                  Put in {r.requestedDepartment.name}
                </Button>
              )}
              {confirmOff === r.id ? (
                <>
                  <Button variant="secondary" disabled={busy === r.id} onClick={() => setConfirmOff(null)}>
                    Keep it
                  </Button>
                  <Button variant="danger" disabled={busy === r.id} onClick={() => void turnOff(r)}>
                    {busy === r.id ? "Saving…" : `Turn off ${r.address}`}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" disabled={busy === r.id} onClick={() => setConfirmOff(r.id)}>
                    Turn off
                  </Button>
                  <Button variant="secondary" disabled={busy === r.id} onClick={() => void confirm(r)}>
                    {busy === r.id ? "Saving…" : "Mark added"}
                  </Button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
