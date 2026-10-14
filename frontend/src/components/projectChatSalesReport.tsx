/* The sales report a project's chat carries, as the chat shows and drives it
 * (owner 2026-10-14). For the three people who report — the Owner, Ummu and
 * Wei Siang (auth/salesAccess.ts canSaveSalesReport):
 *
 *   · a message that reads as a bill list counts at once — the server derives
 *     the event's bills from the chat (routes/project-sales-bills.ts), so the
 *     chat only marks which messages count, and after a post it re-reads the
 *     report and asks the reps of wrong-event orders to amend them;
 *   · a summary message ("9/10: RM10,500 … Total RM48,185") sets Total Sales
 *     when its days add up to its Total, and otherwise offers both figures;
 *   · any message can be voided — it leaves the chat and stops counting.
 *
 * Own module: ProjectChat is about the conversation, and this is about money.
 */
import { useMemo, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { canSaveSalesReport, canWriteProjectFinance } from "../auth/salesAccess";
import { useDialog } from "../hooks/useDialog";
import { useInvalidateProjectSalesBills, useProjectSalesBills } from "../hooks/useProjectSalesBills";
import type { useToast } from "../hooks/useToast";
import { fmtRmSen } from "../lib/projectSalesBills";
import { cn } from "../lib/utils";
import { parseSalesReport, summaryTotalOf } from "../vendor/shared/sales-report-parse";

type ChatMessage = { id: number; action: string; note: string | null };

export type ChatSalesReport = {
  /** The row under a chat message: what it counts for, and its actions. */
  footerFor: (a: ChatMessage) => ReactNode;
  /** Run after the caller's own message was posted. */
  afterSend: (note: string) => Promise<void>;
};

export function useChatSalesReport({
  projectId,
  toast,
  onTotalSet,
  onVoided,
}: {
  projectId: number;
  toast: ReturnType<typeof useToast>;
  /** Total Sales changed — the page re-reads the project. */
  onTotalSet: () => void;
  /** A message was voided — the chat drops it. */
  onVoided: (activityId: number) => void;
}): ChatSalesReport {
  const { user: me, can } = useAuth();
  const dialog = useDialog();
  const canReport = canSaveSalesReport(me);
  const canSetTotal = canReport && canWriteProjectFinance(me, can);
  const billsQ = useProjectSalesBills(projectId, canReport);
  const invalidate = useInvalidateProjectSalesBills();
  const counted = useMemo(() => new Set(billsQ.data?.report_activity_ids ?? []), [billsQ.data]);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function setTotal(activityId: number | null, sen: number) {
    setBusyId(activityId);
    try {
      await api.patch(`/api/projects/${projectId}/finance`, { total_sales: sen / 100 });
      toast.success(`Total Sales set to ${fmtRmSen(sen)}`);
      onTotalSet();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not set Total Sales");
    } finally {
      setBusyId(null);
    }
  }

  async function voidMessage(a: ChatMessage) {
    const first = (a.note ?? "").split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "this message";
    if (!(await dialog.confirm(`Void "${first}"? It leaves the chat and stops counting in this event's sales report.`))) return;
    setBusyId(a.id);
    try {
      await api.post(`/api/project-sales-bills/${projectId}/void/${a.id}`, {});
      onVoided(a.id);
      invalidate();
      toast.success("Voided — it no longer counts for this event");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not void the message");
    } finally {
      setBusyId(null);
    }
  }

  async function afterSend(note: string) {
    if (!canReport) return;
    const parsed = parseSalesReport(note);
    if (parsed.bills.length > 0) {
      invalidate();
      try {
        await api.post(`/api/project-sales-bills/${projectId}/notify`, {});
      } catch (e: unknown) {
        toast.error(e instanceof Error ? `Report counted, but the wrong-event notice failed: ${e.message}` : "The wrong-event notice failed");
      }
      return;
    }
    const s = summaryTotalOf(parsed);
    if (!s || !canSetTotal) return;
    if (s.days_sen == null || s.days_sen === s.total_sen) {
      await setTotal(null, s.total_sen);
    } else {
      toast.error(
        `Total Sales not set: the days add up to ${fmtRmSen(s.days_sen)} but the Total line says ${fmtRmSen(s.total_sen)}. Pick one under the message.`,
      );
    }
  }

  function footerFor(a: ChatMessage): ReactNode {
    if (!canReport || a.action !== "note") return null;
    const parsed = parseSalesReport(a.note);
    const summary = summaryTotalOf(parsed);
    const isCounted = counted.has(a.id);
    const busy = busyId === a.id;
    const daysDiffer = summary != null && summary.days_sen != null && summary.days_sen !== summary.total_sen;
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {parsed.bills.length > 0 && (
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold",
              isCounted ? "border-emerald-600/40 bg-emerald-100 text-emerald-800" : "border-border bg-bg text-ink-muted",
            )}
            title={
              isCounted
                ? "These bills count in this event's sales report"
                : "Not counted: posted by someone other than the Owner, Ummu or Wei Siang, or every bill was pasted again later"
            }
          >
            {isCounted ? "In sales report" : "Not counted"} · {parsed.bills.length} bill{parsed.bills.length === 1 ? "" : "s"} ·{" "}
            {fmtRmSen(parsed.bills.reduce((s, b) => s + b.amount_sen, 0))}
          </span>
        )}
        {summary && canSetTotal && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void setTotal(a.id, summary.total_sen)}
            className="rounded-full border border-emerald-600/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-200 disabled:opacity-50"
            title="Type this message's Total into the event's Total Sales (without transport or disposal)"
          >
            Set Total Sales = {fmtRmSen(summary.total_sen)}
          </button>
        )}
        {summary && canSetTotal && daysDiffer && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void setTotal(a.id, summary.days_sen!)}
            className="rounded-full border border-err/40 bg-err/10 px-2 py-0.5 text-[10px] font-semibold text-err hover:bg-err/20 disabled:opacity-50"
            title="The day lines of this message do not add up to its Total line"
          >
            Days add up to {fmtRmSen(summary.days_sen)} — use this
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void voidMessage(a)}
          className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted hover:bg-err/10 hover:text-err disabled:opacity-50"
          title="Remove a wrong paste: it leaves the chat and stops counting"
        >
          Void
        </button>
      </div>
    );
  }

  return { footerFor, afterSend };
}
