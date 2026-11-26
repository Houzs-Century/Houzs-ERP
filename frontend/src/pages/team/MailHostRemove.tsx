import { useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { useToast } from "../../hooks/useToast";
import { Button } from "../../components/Button";
import { Eyebrow } from "./teamShared";

type ToRemove = Array<{ id: string; address: string; name: string; personLeft: boolean }>;

const KEY = "/api/mail-center/mail-host/to-remove";

export function MailHostRemove() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, reload } = useQuery<ToRemove>(KEY, () => api.get(KEY));
  const rows = data ?? [];
  if (rows.length === 0) return null;

  async function removed(row: ToRemove[number]) {
    setBusy(row.id);
    try {
      await api.post(`/api/mail-center/mail-host/${encodeURIComponent(row.id)}/removed`, {});
      toast.success(`${row.address} marked as removed from Google`);
      reload();
    } catch (e) {
      toast.error((e instanceof Error ? e.message : "Could not mark it").replace(/^\d+:\s*/, ""));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4 lg:col-span-2">
      <Eyebrow>Turned off here, still in Google ({rows.length})</Eyebrow>
      <p className="mb-2 mt-1 text-[12px] leading-relaxed text-ink-secondary">
        Each still uses one of hello@'s Google aliases. In Google Admin, delete the alias from hello@, then mark it removed to free
        the slot.
      </p>
      <div className="flex flex-col divide-y divide-border/60">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-[12.5px]">
            <span className="min-w-0">
              <span className="break-all font-mono text-ink">{r.address}</span>
              <span className="text-ink-secondary">
                {r.name ? ` · ${r.name}` : ""}
                {r.personLeft ? " · account disabled" : ""}
              </span>
            </span>
            <Button variant="secondary" disabled={busy === r.id} onClick={() => void removed(r)}>
              {busy === r.id ? "Saving…" : "Mark removed"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
