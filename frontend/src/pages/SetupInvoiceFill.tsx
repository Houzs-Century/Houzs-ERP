// ----------------------------------------------------------------------------
// Setup Invoice (Roadshow PMS Agent — Job E). Upload a scanned setup/booth
// invoice; it's OCR'd (Claude vision) for the vendor + grand total + line items,
// then you pick the project and apply — writing a `setup` cost line to that
// project's P&L (whole RM). Vendor + amount are editable before you apply in case
// the scan needs a nudge.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { api } from "../api/client";

type Item = { description: string; amountRM: number };
type Proj = { id: number; code: string; name: string; startDate: string | null };
type Scan = { vendor: string | null; currency: string; totalRM: number; items: Item[]; projects: Proj[] };

const rm = (n: number) => `RM ${Math.round(n).toLocaleString()}`;

export function SetupInvoiceFill() {
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [projectId, setProjectId] = useState("");
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<null | { ok: boolean; msg: string }>(null);

  const projects = useMemo(() => scan?.projects ?? [], [scan]);

  async function onFile(file: File) {
    setError(""); setScan(null); setDone(null); setFileName(file.name); setBusy(true);
    try {
      const res = await api.uploadFile<Scan>("/projects/setup-invoice/scan", file, "file");
      setScan(res);
      setVendor(res.vendor ?? "");
      setAmount(res.totalRM ? String(res.totalRM) : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the invoice.");
    } finally { setBusy(false); }
  }

  async function apply() {
    setDone(null);
    const amt = Number(amount);
    if (!projectId) { setDone({ ok: false, msg: "Pick a project." }); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setDone({ ok: false, msg: "Enter a valid amount." }); return; }
    setApplying(true);
    try {
      await api.post(`/projects/${projectId}/setup-invoice/apply`, { vendor: vendor.trim(), amountRM: amt, note: null });
      const p = projects.find((x) => String(x.id) === projectId);
      setDone({ ok: true, msg: `Added ${rm(amt)} setup cost to ${p?.code ?? "the project"}.` });
    } catch (e) {
      setDone({ ok: false, msg: e instanceof Error ? e.message : "Apply failed." });
    } finally { setApplying(false); }
  }

  return (
    <div style={{ padding: 20, maxWidth: 820 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Setup Invoice</h1>
      <p style={{ fontSize: 13, color: "var(--fg-muted,#666)", marginBottom: 16 }}>
        Upload a scanned setup / booth invoice. The vendor and total are read automatically; pick the
        project and apply to add it as a <strong>setup</strong> cost line to that project's P&L.
      </p>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 14px", border: "1px solid var(--border,#ccc)", borderRadius: 8, cursor: "pointer", background: "var(--bg-subtle,#f7f7f7)" }}>
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{busy ? "Reading invoice…" : "Choose invoice (image/PDF)"}</span>
      </label>
      {fileName && <span style={{ marginLeft: 12, fontSize: 12, color: "var(--fg-muted,#666)" }}>{fileName}</span>}
      {error && <p style={{ color: "var(--c-error,#c00)", fontSize: 13, marginTop: 10 }}>{error}</p>}

      {scan && (
        <div style={{ marginTop: 18, border: "1px solid var(--border,#ddd)", borderRadius: 10, padding: 16 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--fg-muted,#666)" }}>Vendor</span>
              <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Supplier / contractor"
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border,#ccc)", fontSize: 13, minWidth: 220 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--fg-muted,#666)" }}>Total (RM)</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border,#ccc)", fontSize: 13, width: 140 }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--fg-muted,#666)" }}>Apply to project</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border,#ccc)", fontSize: 13, minWidth: 240 }}>
                <option value="">— pick a project —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}{p.startDate ? ` (${p.startDate})` : ""}</option>)}
              </select>
            </label>
            <button onClick={apply} disabled={applying}
              style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--c-primary,#146c43)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {applying ? "Applying…" : "Apply setup cost"}
            </button>
          </div>

          {done && <p style={{ marginTop: 12, fontSize: 13, color: done.ok ? "#15803d" : "#c00" }}>{done.msg}</p>}

          {scan.items.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: "var(--fg-muted,#666)", marginBottom: 4 }}>Line items read (for reference)</div>
              <div style={{ fontSize: 12 }}>
                {scan.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "2px 0" }}>
                    <span style={{ color: "var(--fg,#333)" }}>{it.description || "—"}</span>
                    <span style={{ color: "var(--fg-muted,#666)" }}>{rm(it.amountRM)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SetupInvoiceFill;
