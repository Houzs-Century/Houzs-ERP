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
//
// TWO ACTIONS ON ONE LIST, since 2026-09-09. The owner asked whether the orders
// could go to SEVERAL people at once — "可以让接手的几位 sales person 都有权限" —
// and, asked whose name the account book should then carry, ruled 全部平等，
// 不设主. So the panel offers the two operations separately rather than turning
// the handover into a multi-select whose first entry silently becomes primary:
//
//   Hand them to    → one person, MOVES attribution (salesperson_id + agent +
//                     the AutoCount edit). What a resignation needs.
//   Also give access to → any number of people, GRANTS access and nothing else.
//                     Nobody's name changes and the account book is untouched.
//
// Both act on the same previewed list, so the operator can do one, the other, or
// both — and each button is enabled only by its own field, so neither can fire
// by accident while the operator was filling in the other.
// ----------------------------------------------------------------------------
import { useState } from "react";
import { ArrowRight, Loader2, UserCog, UserPlus, X } from "lucide-react";
import { Button } from "../../components/Button";
import { SearchableSelect } from "../../vendor/scm/components/SearchableSelect";
import { authedFetch } from "../../vendor/scm/lib/authed-fetch";
import { usePickableStaff } from "../../vendor/scm/lib/admin-queries";
import { useSoHandoverHolders } from "../../vendor/scm/lib/sales-order-queries";

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
type ShareResult = {
  changed: Array<{ docNo: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
};
/* Both runs report the same two lists, so one result box renders either. `verb`
   is what the operator did, because "12 orders" alone does not say whether they
   were moved or shared — and those are very different things to have just done
   to a live order book. */
type BatchResult = {
  verb: string;
  done: Array<{ docNo: string }>;
  skipped: Array<{ docNo: string; reason: string }>;
};

const selectCls =
  "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary disabled:opacity-60";

export function SalespersonHandover() {
  /* FROM lists WHO HOLDS ORDERS, most first (useSoHandoverHolders — its own
     comment has the measurement). It used to read the staff roster, which is
     scoped by a person's company LINK and therefore hid exactly the resigned
     AutoCount reps this panel exists for.
     TO still reads the company-scoped ACTIVE list, so an order can never land
     on a departed or cross-company rep — that direction genuinely wants the
     roster, and wants it narrow. */
  const holdersQ = useSoHandoverHolders();
  const holders = holdersQ.data ?? [];
  const pickableQ = usePickableStaff();
  const pickable = [...(pickableQ.data ?? [])].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
  );

  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [shareIds, setShareIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; action: "move" | "share" } | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Resolves against BOTH lists: the From side comes from holders, the To /
     share side from the pickable roster, and one id can be in either. Falls
     back to the staff code and never to a raw uuid — a holder whose staff row
     has no name is still somebody the operator must be able to identify. */
  const nameOf = (id: string) => {
    const h = holders.find((x) => x.staffId === id);
    if (h) return h.name || h.staffCode || "(unnamed)";
    return pickable.find((s) => s.id === id)?.name || "—";
  };

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
    setProgress({ done: 0, total: docNos.length, action: "move" });
    const moved: ApplyResult["moved"] = [];
    const skipped: ApplyResult["skipped"] = [];
    try {
      for (let i = 0; i < docNos.length; i += size) {
        const batch = docNos.slice(i, i + size);
        /* Typed PARTIAL on purpose: this is the wire, not a local object. The
           `?? []` below is the guard that keeps a shape surprise from throwing
           inside the loop and abandoning the batches that follow — declaring the
           response fully-populated would make that guard read as dead code. */
        const res = await authedFetch<Partial<ApplyResult>>("/so-handover/apply", {
          method: "POST",
          body: JSON.stringify({ fromStaffId: fromId, toStaffId: toId, docNos: batch }),
        });
        moved.push(...(res.moved ?? []));
        skipped.push(...(res.skipped ?? []));
        setProgress({ done: Math.min(i + size, docNos.length), total: docNos.length, action: "move" });
      }
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "The handover failed."} `
        + `${moved.length} of ${docNos.length} order(s) had already moved.`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
      setResult({ verb: "Moved", done: moved, skipped });
      /* The moved orders now belong to someone else, so the preview on screen
         is stale by definition — reload it rather than leave a list that would
         re-submit no-ops. */
      void loadPreviewSilently(fromId);
    }
  }

  /* Grant or withdraw ACCESS on the same previewed list. Batched and reported
     exactly like apply(); deliberately does NOT refresh the preview afterwards,
     because sharing does not change who the orders are attributed to — the list
     on screen is still true, and blanking it would suggest something moved. */
  async function share(mode: "add" | "remove") {
    if (!preview || shareIds.length === 0) return;
    const docNos = preview.orders.map((o) => o.docNo);
    const size = preview.batchMax || 25;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: docNos.length, action: "share" });
    const changed: BatchResult["done"] = [];
    const skipped: BatchResult["skipped"] = [];
    try {
      for (let i = 0; i < docNos.length; i += size) {
        const batch = docNos.slice(i, i + size);
        /* Partial for the same reason apply()'s is: this is the wire, and the
           `?? []` is what stops one odd payload abandoning the batches behind
           it. */
        const res = await authedFetch<Partial<ShareResult>>("/so-handover/share", {
          method: "POST",
          body: JSON.stringify({ staffIds: shareIds, docNos: batch, mode }),
        });
        changed.push(...(res.changed ?? []));
        skipped.push(...(res.skipped ?? []));
        setProgress({ done: Math.min(i + size, docNos.length), total: docNos.length, action: "share" });
      }
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : "Sharing failed."} `
        + `${changed.length} of ${docNos.length} order(s) had already been updated.`,
      );
    } finally {
      setBusy(false);
      setProgress(null);
      setResult({
        verb: mode === "remove" ? "Withdrew access on" : "Shared",
        done: changed,
        skipped,
      });
    }
  }

  async function loadPreviewSilently(staffId: string) {
    try {
      const next = await authedFetch<Partial<Preview>>(
        `/so-handover/preview?from=${encodeURIComponent(staffId)}`,
      );
      /* Shape-check before replacing a list the operator is looking at: this
         refresh runs right after a write, and swapping a good list for a
         half-shaped payload would blank the screen at the worst moment. */
      if (Array.isArray(next.orders) && typeof next.total === "number") {
        setPreview(next as Preview);
      }
    } catch {
      /* The handover result is what matters here; a failed refresh must not
         overwrite it with an error the operator cannot act on. */
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-ink-secondary">
        Two things you can do to every listed Sales Order. <strong>Hand them to</strong>{" "}
        moves them to one salesperson, who becomes the rep the order and the account
        book name. <strong>Also give access to</strong> lets any number of salespeople
        see and edit them without changing whose orders they are — use it when several
        people share the follow-up. Either way, delivered and invoiced orders are
        included; their Delivery Orders and Sales Invoices keep the rep who sold them,
        so nothing about commission or the account book's figures changes.
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
            disabled={busy || holdersQ.isLoading}
            value={fromId}
            onChange={(v) => {
              setFromId(v);
              void loadPreview(v);
            }}
            /* The COUNT is in the label on purpose: this list is ordered by it,
               and it is the number the operator is about to act on. `inactive`
               still shows — most people here have left, which is the point. */
            options={holders.map((h) => {
              const who = h.name || h.staffCode || "(unnamed)";
              return {
                value: h.staffId,
                label: `${who}${h.active === false ? " (inactive)" : ""} — ${h.orders}`,
              };
            })}
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

      {/* The picker stays a single SearchableSelect and ADDS to a chip list,
          rather than a second multi-select control nobody else in this codebase
          uses. It reads back to "" after each pick so the same control can add
          the next person. */}
      <label className="block">
        <span className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
          Also give access to
        </span>
        <SearchableSelect
          className={selectCls}
          ariaLabel="Also give access to"
          placeholder="— Add a salesperson who should also see these —"
          disabled={busy || pickableQ.isLoading}
          value=""
          onChange={(v) => {
            if (v) setShareIds((prev) => (prev.includes(v) ? prev : [...prev, v]));
          }}
          options={pickable
            .filter((s) => !shareIds.includes(s.id))
            .map((s) => ({ value: s.id, label: s.name }))}
        />
        {shareIds.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {shareIds.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-2.5 pr-1 text-[11px] text-ink"
              >
                {nameOf(id)}
                <button
                  type="button"
                  aria-label={`Remove ${nameOf(id)}`}
                  disabled={busy}
                  onClick={() => setShareIds((prev) => prev.filter((x) => x !== id))}
                  className="rounded-full p-0.5 text-ink-muted hover:bg-bg hover:text-ink disabled:opacity-50"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </label>

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
            {/* Each button is gated by its OWN field, so the one the operator
                has not filled in cannot fire. `progress` carries the action that
                owns it, so a running handover cannot make the Share button count
                orders it is not touching. */}
            <div className="flex flex-wrap items-center gap-2">
              {shareIds.length > 0 && (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy || preview.orders.length === 0}
                    onClick={() => void share("remove")}
                  >
                    Withdraw
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || preview.orders.length === 0}
                    onClick={() => void share("add")}
                    icon={busy ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                  >
                    {progress?.action === "share"
                      ? `Sharing ${progress.done}/${progress.total}…`
                      : `Share with ${shareIds.length}`}
                  </Button>
                </>
              )}
              <Button
                variant="primary"
                disabled={busy || !toId || preview.orders.length === 0}
                onClick={() => void apply()}
                icon={busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              >
                {progress?.action === "move"
                  ? `Moving ${progress.done}/${progress.total}…`
                  : `Move to ${toId ? nameOf(toId) : "…"}`}
              </Button>
            </div>
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
            {result.verb} {result.done.length} order{result.done.length === 1 ? "" : "s"}
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
