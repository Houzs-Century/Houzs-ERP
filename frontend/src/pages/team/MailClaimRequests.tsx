import { useState } from "react";
import { api } from "../../api/client";
import { useQuery } from "../../hooks/useQuery";
import { queryClient } from "../../lib/queryClient";
import { useToast } from "../../hooks/useToast";
import { Button } from "../../components/Button";
import { Eyebrow } from "./teamShared";
import { fmtDate } from "../../vendor/shared/format";

type Requests = {
  usage: { used: number; limit: number };
  requests: Array<{ id: string; userId: number; name: string; address: string; createdAt: string; department: string | null }>;
};

const KEY = "/api/mail-center/mail-host/requests";

/* Owner 2026-11-24: every address is a Google alias of hello@, and the account
 * holds a limited number, so a member's claim waits here. Approving makes the
 * mailbox (it then appears under "Waiting to be added in Google Workspace");
 * rejecting needs a reason the member sees. */
export function MailClaimRequests() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const { data, reload } = useQuery<Requests>(KEY, () => api.get(KEY));
  if (!data || data.requests.length === 0) return null;
  const full = data.usage.used >= data.usage.limit;

  async function act(id: string, path: "approve" | "reject", body: object, done: string) {
    setBusy(id);
    try {
      await api.post(`${KEY}/${encodeURIComponent(id)}/${path}`, body);
      toast.success(done);
      setRejecting(null);
      setReason("");
      reload();
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "uq" && String(q.queryKey[1]).startsWith("/api/mail-center"),
      });
    } catch (e) {
      toast.error((e instanceof Error ? e.message : "Could not save").replace(/^\d+:\s*/, ""));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 lg:col-span-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Address requests to approve ({data.requests.length})</Eyebrow>
        <span className={full ? "text-[12px] font-semibold text-err" : "text-[12px] text-ink-secondary"}>
          Google aliases used: {data.usage.used} / {data.usage.limit}
        </span>
      </div>
      <p className="mb-2 mt-1 text-[12px] leading-relaxed text-ink-secondary">
        {full
          ? "All aliases are in use. Turn off an address nobody uses before approving."
          : "Approving gives the person the address; then add it in Google Admin as an alias of hello@ and mark it added below."}
      </p>
      <div className="flex flex-col divide-y divide-border/60">
        {data.requests.map((r) => (
          <div key={r.id} className="flex flex-col gap-1.5 py-1.5 text-[12.5px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="break-all font-mono text-ink">{r.address}</span>
                <span className="text-ink-secondary">
                  {r.name ? ` · ${r.name}` : ""}
                  {r.department ? ` · ${r.department}` : ""}
                  {` · asked ${fmtDate(r.createdAt)}`}
                </span>
              </span>
              <span className="flex gap-2">
                <Button variant="secondary" disabled={busy === r.id} onClick={() => setRejecting(rejecting === r.id ? null : r.id)}>
                  Reject
                </Button>
                <Button disabled={busy === r.id || full} onClick={() => void act(r.id, "approve", {}, `${r.address} approved`)}>
                  {busy === r.id ? "Saving…" : "Approve"}
                </Button>
              </span>
            </div>
            {rejecting === r.id && (
              <div className="flex flex-wrap gap-2">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why? The person sees this, e.g. Use your own name"
                  aria-label="Reason"
                  maxLength={300}
                  className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-ink outline-none focus:border-primary"
                />
                <Button
                  variant="secondary"
                  disabled={busy === r.id || !reason.trim()}
                  onClick={() => void act(r.id, "reject", { reason: reason.trim() }, `${r.address} rejected`)}
                >
                  Send rejection
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
