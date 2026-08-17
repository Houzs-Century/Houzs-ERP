// ----------------------------------------------------------------------------
// SalespersonHandover — hand one salesperson's Sales Orders to another.
//
// Owner 2026-08-17, on a resignation: "销售订单是否可以分配给第二个人 PIC 来更新
// 销售订单". One order at a time through SO Detail is the wrong tool for fifty of
// them, and the departed rep's orders are invisible to their replacement until
// they move (SO row-level visibility keys off `salesperson_id`).
//
// Deliberately a THREE-STEP flow, not one button: pick who is leaving → SEE the
// exact orders that will move → pick who takes them. The middle step is the
// point. This writes to live orders, and "57 orders" is a number the operator
// should read before, not after.
//
// The API caps a batch at 25 (a worker request is a read + write + audit +
// AutoCount enqueue per order), so this loops batches and reports progress. A
// batch that fails stops the run with what has moved so far still reported —
// half-applied and SAID SO beats half-applied in silence.
// ----------------------------------------------------------------------------
import { useState } from "react";
import { ArrowRight, Loader2, UserCog } from "lucide-react";
import { Button } from "../../components/Button";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { useStaff, usePickableStaff } from "../../vendor/scm/lib/admin-queries";

type PreviewOrder = {
  docNo: string;
  soDate: string | null;
  customer: string | null;
  status: string | null;
};
type Preview = {
  from: string;
  total: number;
  truncated: boolean;
  batchMax: number;
  orders: PreviewOrder[];
};
type ApplyResult = {
  moved: Array<{ docNo: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
};

const selectCls =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary disabled:opacity-60";

export function SalespersonHandover() {
  /* FROM reads the FULL roster (useStaff) — the person handing over has usually
     been deactivated already, and an active-only list would hide exactly the
     case this tool exists for. TO reads the company-scoped ACTIVE list, so an
     order can never land on a departed or cross-company rep. */
  const rosterQ = useStaff();
  const pickableQ = usePickableStaff();
  const roster = [...(rosterQ.data ?? [])].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
  );
  const pickable = [...(pickableQ.data ?? [])].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
  );

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (id: string) => roster.find((s) => s.id === id)?.name || "—";

  async function loadPreview(staffId: string) {
    setPreview(null);
    setResult(null);
    setError(null);
    if (!staffId) return;
    setBusy(true);
    try {
      setPreview(
        await authedFetch<Preview>(`/so-handover/preview?from=${encodeURIComponent(staffId)}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load that salesperson's orders.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || !fromId || !toId) return;
    const docNos = preview.orders.map((o) => o.docNo);
    const size = preview.batchMax || 25;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: docNos.length });
    const moved: ApplyResult["moved"] = [];
    const skipped: ApplyResult["skipped"] = [];
    try {
      for (let i = 0; i < docNos.length; i += size) {
        const batch = docNos.slice(i, i + size);
        const res = await authedFetch<ApplyResult>("/so-handover/apply", {
          method: "POST",
          body: JSON.stringify({ fromStaffId: fromId, toStaffId: toId, docNos: batch }),
        });
        moved.push(...(res.moved ?? []));
        skipped.push(...(res.skipped ?? []));
        setProgress({ done: Math.min(i + size, docNos.length), total: docNos.length });
      }
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "The handover failed."} `
        + `${moved.length} of ${docNos.length} order(s) had already moved.`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
      setResult({ moved, skipped });
      /* The moved orders now belong to someone else, so the preview on screen
         is stale by definition — reload it rather than leave a list that would
         re-submit no-ops. */
      void loadPreviewSilently(fromId);
    }
  }

  async function loadPreviewSilently(staffId: string) {
    try {
      const next = await authedFetch<Preview>(
        `/so-handover/preview?from=${encodeURIComponent(staffId)}`,
      );
      /* Shape-check before replacing a list the operator is looking at: this
         refresh runs right after a write, and swapping a good list for a
         half-shaped payload would blank the screen at the worst moment. */
      if (Array.isArray(next?.orders)) setPreview(next);
    } catch {
      /* The handover result is what matters here; a failed refresh must not
         overwrite it with an error the operator cannot act on. */
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-ink-secondary">
        Moves every listed Sales Order to another salesperson — who can then see and
        edit them. Delivered and invoiced orders move too; their Delivery Orders and
        Sales Invoices keep the rep who sold them, so nothing about commission or
        the account book's figures changes.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Orders currently with
          </span>
          <SearchableSelect
            className={selectCls}
            ariaLabel="Orders currently with"
            placeholder="— Pick the salesperson leaving —"
            disabled={busy || rosterQ.isLoading}
            value={fromId}
            onChange={(v) => {
              setFromId(v);
              void loadPreview(v);
            }}
            options={roster.map((s) => ({
              value: s.id,
              label: s.active ? s.name : `${s.name} (inactive)`,
            }))}
          />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Hand them to
          </span>
          <SearchableSelect
            className={selectCls}
            ariaLabel="Hand them to"
            placeholder="— Pick who takes over —"
            disabled={busy || pickableQ.isLoading}
            value={toId}
            onChange={setToId}
            options={pickable
              .filter((s) => s.id !== fromId)
              .map((s) => ({ value: s.id, label: s.name }))}
          />
        </label>
      </div>

      {error && (
        <div className="rounded-md border border-err/30 bg-err/5 px-3 py-2 text-[12px] text-err">
          {error}
        </div>
      )}

      {preview && (
        <div className="rounded-md border border-border bg-bg/50">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
            <span className="text-[12px] text-ink">
              <strong>{preview.total.toLocaleString("en-MY")}</strong> order
              {preview.total === 1 ? "" : "s"} with {nameOf(fromId)}
              {preview.truncated && (
                <span className="text-ink-muted">
                  {" "}— showing the first {preview.orders.length}; run it again for the rest
                </span>
              )}
            </span>
            <Button
              variant="primary"
              disabled={busy || !toId || preview.orders.length === 0}
              onClick={() => void apply()}
              icon={busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
            >
              {progress
                ? `Moving ${progress.done}/${progress.total}…`
                : `Move to ${toId ? nameOf(toId) : "…"}`}
            </Button>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {preview.orders.length === 0 ? (
              <div className="px-3 py-4 text-[12px] text-ink-muted">
                Nothing to hand over — this salesperson has no orders in this company.
              </div>
            ) : (
              <table className="w-full text-[12px]">
                <tbody>
                  {preview.orders.map((o) => (
                    <tr key={o.docNo} className="border-b border-border-subtle/60 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-[11px] text-ink">{o.docNo}</td>
                      <td className="px-3 py-1.5 text-ink-secondary">{o.customer ?? "—"}</td>
                      <td className="px-3 py-1.5 text-ink-muted">{o.soDate ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right text-ink-muted">
                        {(o.status ?? "").replace(/_/g, " ").toLowerCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-[12px]">
          <div className="flex items-center gap-1.5 font-semibold text-ink">
            <UserCog size={13} />
            Moved {result.moved.length} order{result.moved.length === 1 ? "" : "s"}
            {result.skipped.length > 0 && ` · skipped ${result.skipped.length}`}
          </div>
          {result.skipped.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-ink-secondary">
              {result.skipped.map((s) => (
                <li key={s.docNo}>
                  <span className="font-mono text-[11px]">{s.docNo}</span> — {s.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
