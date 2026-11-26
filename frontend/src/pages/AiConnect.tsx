import { useEffect, useState } from "react";
import { Check, Info, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { Button } from "../components/Button";

type Consent = { app: string; clientName: string; redirectHost: string; user: { name: string; email: string }; allowed: boolean };

const errText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(m) as { error?: string };
    return j.error ?? m;
  } catch {
    return m;
  }
};

export function AiConnect() {
  const id = new URLSearchParams(window.location.search).get("request") ?? "";
  const [data, setData] = useState<Consent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (!id) {
      setErr("This link is incomplete. Start again from the AI app.");
      return;
    }
    const ctl = new AbortController();
    api
      .get<Consent>(`/api/mcp-admin/consent/${encodeURIComponent(id)}`, { signal: ctl.signal })
      .then(setData)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setErr(errText(e));
      });
    return () => ctl.abort();
  }, [id]);

  const decide = async (decision: "allow" | "deny") => {
    setBusy(true);
    try {
      const r = await api.post<{ redirect: string }>(`/api/mcp-admin/consent/${encodeURIComponent(id)}`, { decision });
      window.location.assign(r.redirect);
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };

  const request = async () => {
    setBusy(true);
    try {
      await api.post("/api/mcp-admin/me/request", { reason: `Connecting ${data?.app ?? "an AI app"}` });
      setRequested(true);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-start justify-center bg-surface-dim px-4 py-12">
      <div className="w-full max-w-[480px] rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-white" aria-hidden="true">
            <ShieldCheck size={22} />
          </div>
          <div className="font-semibold text-ink">Houzs ERP · AI Connector</div>
        </div>

        {err && (
          <div role="alert" className="rounded-lg border border-err/40 bg-err-bg p-3 text-sm text-err">
            {err}
          </div>
        )}

        {!err && !data && <p className="text-sm text-ink-muted">Loading…</p>}

        {data && !data.allowed && (
          <>
            <h1 className="mb-2 text-xl font-semibold text-ink">AI Connector is not turned on for your account</h1>
            <p className="mb-4 text-sm text-ink-secondary">
              Signed in as <b className="text-ink">{data.user.name}</b>. Ask for access; you will be able to connect once it is approved.
            </p>
            {requested ? (
              <p className="rounded-lg bg-synced-bg p-3 text-sm text-ink">Request sent. Try connecting again after it is approved.</p>
            ) : (
              <Button onClick={() => void request()} disabled={busy} className="h-11 w-full justify-center">
                Request access
              </Button>
            )}
          </>
        )}

        {data?.allowed && (
          <>
            <h1 className="mb-2 text-xl font-semibold text-ink">{data.app} wants to read Houzs ERP as you</h1>
            <p className="mb-4 text-sm text-ink-secondary">
              Signed in as <b className="text-ink">{data.user.name}</b>
            </p>
            <ul className="mb-6 space-y-3 text-sm text-ink-secondary">
              <li className="flex gap-2.5">
                <Check size={18} className="mt-0.5 shrink-0 text-synced" aria-hidden="true" />
                <span>
                  <b className="text-ink">Looks things up.</b> It cannot change orders, money or stock. Only if your admin allows it can it book a meeting or send an email for you, and only after you confirm.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Check size={18} className="mt-0.5 shrink-0 text-synced" aria-hidden="true" />
                <span>
                  <b className="text-ink">Only what you can see.</b> The same pages and figures your ERP login shows you, nothing more.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Check size={18} className="mt-0.5 shrink-0 text-synced" aria-hidden="true" />
                <span>
                  <b className="text-ink">Logged.</b> Your admin can see what was looked up and when.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Info size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                <span>What it reads is sent to {data.app} to answer you. Stop any time in System &gt; AI Connector.</span>
              </li>
            </ul>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void decide("allow")} disabled={busy} className="h-11 flex-1 justify-center">
                Allow
              </Button>
              <Button variant="secondary" onClick={() => void decide("deny")} disabled={busy} className="h-11 flex-1 justify-center">
                Cancel
              </Button>
            </div>
            {data.redirectHost && <p className="mt-4 text-xs text-ink-muted">You will return to {data.redirectHost}.</p>}
          </>
        )}
      </div>
    </main>
  );
}
