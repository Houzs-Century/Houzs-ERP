/* "Save as sales report" — the step between a message pasted in a project's
 * chat and the bills the project keeps (owner 2026-10-14). The chat recognises
 * the report shape; this dialog shows what the server read from it — each
 * bill, whether it is already saved, whether it is already an order — and
 * saves on one click. Nothing is saved without this look.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api } from "../api/client";
import type { useToast } from "../hooks/useToast";
import { cn } from "../lib/utils";
import { billStatusLabel, fmtRmSen, type SalesReportPreview } from "../lib/projectSalesBills";

const TONE: Record<"red" | "green" | "amber" | "grey", string> = {
  red: "bg-err/10 text-err",
  green: "bg-emerald-100 text-emerald-800",
  amber: "bg-amber-100 text-amber-800",
  grey: "bg-bg text-ink-muted",
};

export function SalesReportSaveDialog({
  projectId,
  activityId,
  text,
  onClose,
  onSaved,
  toast,
}: {
  projectId: number;
  /** The chat message the text came from, so the chat can mark it saved. */
  activityId: number | null;
  text: string;
  onClose: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [preview, setPreview] = useState<SalesReportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    api
      .post<SalesReportPreview>(`/api/project-sales-bills/${projectId}/preview`, { text })
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not read the report."); });
    return () => { cancelled = true; };
  }, [projectId, text]);

  async function save() {
    if (!preview || preview.bills.length === 0 || saving) return;
    setSaving(true);
    try {
      const r = await api.post<{ saved: number; notified: number; totals: { opened_count: number } }>(
        `/api/project-sales-bills/${projectId}`,
        { text, source_activity_id: activityId },
      );
      const notice = r.notified > 0 ? ` · ${r.notified} salesperson notified about a wrong event` : "";
      toast.success(`Saved ${r.saved} bill${r.saved === 1 ? "" : "s"} to this event${notice}`);
      onSaved();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const bills = preview?.bills ?? [];
  const sum = bills.reduce((s, b) => s + b.amount_sen, 0);
  const newCount = bills.filter((b) => !b.existing).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" role="dialog" aria-label="Save as sales report">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-surface shadow-stone">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="text-[12.5px] font-semibold text-ink">Save as sales report</div>
          {preview && (
            <div className="text-[10.5px] text-ink-muted">
              {bills.length} bill{bills.length === 1 ? "" : "s"} · {fmtRmSen(sum)}
              {preview.report_date ? ` · ${preview.report_date}` : ""}
              {newCount !== bills.length ? ` · ${bills.length - newCount} already saved (will be updated)` : ""}
            </div>
          )}
          <button onClick={onClose} className="ml-auto rounded p-1 text-ink-muted hover:bg-bg hover:text-ink" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[11.5px]">
          {!preview && !error && <div className="text-ink-muted">Reading the report…</div>}
          {error && <div className="rounded-md border border-err/40 bg-err/5 p-2 text-err">{error}</div>}
          {preview && bills.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-ink-muted">
              No bill lines were found in this message. A bill line reads like: 1. HC8993 RM6500 Jason
            </div>
          )}
          {preview && bills.length > 0 && (
            <table className="w-full">
              <thead>
                <tr className="text-left font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
                  <th className="py-1 pr-2">Ref No.</th>
                  <th className="py-1 pr-2 text-right">Amount</th>
                  <th className="py-1 pr-2">Sales Person</th>
                  <th className="py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => {
                  const st = billStatusLabel(b.match);
                  return (
                    <tr key={b.line} className="border-t border-border-subtle">
                      <td className="py-1 pr-2 font-mono">{b.ref_raw}</td>
                      <td className="py-1 pr-2 text-right font-mono">{fmtRmSen(b.amount_sen)}</td>
                      <td className="py-1 pr-2">{b.salesperson_name || "—"}</td>
                      <td className="py-1">
                        <span className={cn("inline-flex rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider", TONE[st.tone])}>
                          {st.text}
                        </span>
                        {b.match.so_doc_no && <span className="ml-1 font-mono text-[10px] text-ink-muted">{b.match.so_doc_no}</span>}
                        {b.existing && <span className="ml-1 text-[10px] text-ink-muted">already saved</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {preview && preview.warnings.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-[10.5px] text-amber-800">
              {preview.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {preview && preview.skipped.length > 0 && (
            <div className="mt-2 text-[10.5px] text-ink-muted">
              Not read as bills:{" "}
              {preview.skipped.map((s) => <span key={s.line} className="mr-2 font-mono">{s.text}</span>)}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <button onClick={onClose} className="rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink-secondary hover:text-ink">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !preview || bills.length === 0}
            className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : `Save ${bills.length ? `${bills.length} bill${bills.length === 1 ? "" : "s"}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
