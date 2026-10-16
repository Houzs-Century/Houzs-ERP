import { useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { Button } from "../../components/Button";
import { Eyebrow } from "./teamShared";
import { fmtDate } from "../../vendor/shared/format";

type Pending = { id: string; address: string; name: string; createdAt: string | null };

/* DEV-03 R2: a personal address the ERP gave a new member receives mail only
 * once it is added in Google Workspace, as an alias of an account Mail Center
 * already syncs. Each row leaves the list when an admin marks it, or by itself
 * when the first mail to it arrives. */
export function MailHostPending() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
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
              </span>
            </span>
            <Button variant="secondary" disabled={busy === r.id} onClick={() => void confirm(r)}>
              {busy === r.id ? "Saving…" : "Mark added"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
