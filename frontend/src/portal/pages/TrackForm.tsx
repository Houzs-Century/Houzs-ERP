import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { PortalFrame } from "../components/PortalFrame";
import { portalApi } from "../portalApi";

// Public page at /track. Customer enters their ASSR number + phone.
// On match, backend issues a 30-min token and we redirect to the
// self-contained portal case URL.

export function TrackForm() {
  const [assrNo, setAssrNo] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await portalApi.post<{ token: string; assr_no: string }>(
        "/api/track",
        null,
        { assr_no: assrNo.trim(), phone: phone.trim() }
      );
      nav(`/portal/case/${res.token}`, { replace: true });
    } catch (e: any) {
      setErr(e?.message || "Couldn't find that case.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PortalFrame>
      <div className="mx-auto max-w-sm">
        <h1 className="font-display text-2xl font-extrabold tracking-tight">Track your service case</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Enter your case number and the phone number on file.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Case Number
            </label>
            <input
              required
              autoFocus
              value={assrNo}
              onChange={(e) => setAssrNo(e.target.value)}
              placeholder="ASSR/2604-001"
              className="w-full rounded-md border border-border bg-surface px-3 py-2.5 font-mono text-sm uppercase outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-1 text-[10px] text-ink-muted">
              Format: ASSR/YYMM-NNN — found on your case receipt or WhatsApp message.
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Phone Number
            </label>
            <input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="012-345 6789"
              className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="mt-1 text-[10px] text-ink-muted">
              The phone number you gave when the case was opened.
            </div>
          </div>

          {err && (
            <div className="rounded-md border border-err/40 bg-err/5 px-3 py-2 text-sm text-err">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !assrNo.trim() || !phone.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-[12px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
          >
            <Search size={12} />
            {busy ? "Looking up…" : "View my case"}
          </button>
        </form>

        <div className="mt-6 rounded-md border border-border bg-surface/50 p-4 text-[11px] text-ink-muted">
          <div className="font-semibold text-ink-secondary">No login required</div>
          <div className="mt-1">
            This portal doesn't use passwords. Your case number and phone number
            together give you short-lived access. If Houzs Century sent you a
            direct link by WhatsApp, just click that link instead.
          </div>
        </div>
      </div>
    </PortalFrame>
  );
}
