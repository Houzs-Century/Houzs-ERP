// ----------------------------------------------------------------------------
// PoLineAllocationsModal — split ONE Purchase Order line across the customers
// (and stock) a consolidated purchase serves (mig 0235).
//
// The owner's live case: 2990-PO-2606-023's single qty-5 MAKOTO line covers
// SO-036 x1 + SO-029 x1 + 3 for stock — a shape the single-valued so_item_id
// cannot express. Each slice here is a sub-numbered allocation
// (PO-2606-023-01, -02, ...) of (qty, SO line | STOCK). When any exist they are
// the authoritative fine-grained answer: the Assigned SO column reads THEM for
// this line instead of the single so_item_id.
//
// Immediate-mode editor: every row action is its own backend write (the CRUD
// endpoints), so a half-finished split is still a valid split — there is no
// client-side staging to lose. The server enforces the qty cap
// (sum <= line qty) and the same-SKU/same-company SO gate; refusals arrive as
// plain sentences via authedFetch's humanApiError and are shown verbatim.
//
// Deliberately available on RECEIVED POs (no downstream lock): attributing
// historical consolidated purchases by hand is the reason this exists.
// ----------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { Split, Trash2, Plus } from "lucide-react";
import { ModalOverlay } from "./DocumentRelationshipMapModal";
import { Button } from "../Button";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { formatDate } from "../../lib/utils";
import {
  usePurchaseOrderDetail,
  useSoLineCandidates,
  useAddPoLineAllocation,
  useUpdatePoLineAllocation,
  useDeletePoLineAllocation,
  type PoItemRow,
  type PoLineAllocation,
} from "../../vendor/scm/lib/suppliers-queries";

/* The printable sub-number: PO-2606-001 + seq 2 -> "PO-2606-001-02". Mirrors
   backend allocationSubNumber (scm/lib/po-allocations.ts). */
const subNumberOf = (poNumber: string | null | undefined, seq: number): string =>
  `${poNumber ?? ""}-${String(seq).padStart(2, "0")}`;

const plainError = (e: unknown): string =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";

const STOCK = "";

export function PoLineAllocationsModal({
  poId,
  poNumber,
  lineId,
  onClose,
}: {
  poId: string;
  poNumber: string;
  lineId: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const detail = usePurchaseOrderDetail(poId);
  // Re-derive the line from the LIVE detail (each write invalidates it), so the
  // slices, the allocated sum and the remaining figure can never go stale.
  const line = useMemo<PoItemRow | null>(
    () => (detail.data?.items ?? []).find((l) => l.id === lineId) ?? null,
    [detail.data, lineId],
  );
  const allocations = useMemo<PoLineAllocation[]>(
    () => [...(line?.allocations ?? [])].sort((a, b) => a.seq - b.seq),
    [line],
  );
  const allocated = allocations.reduce((s, a) => s + Number(a.qty ?? 0), 0);
  const lineQty = Number(line?.qty ?? 0);
  const remaining = Math.max(0, lineQty - allocated);

  // Same item code, same company — including already-picked / delivered lines
  // (historical consolidated POs are the point; the shortage picker hides them).
  const candidates = useSoLineCandidates(line?.material_code ?? null);

  const addAlloc = useAddPoLineAllocation();
  const updateAlloc = useUpdatePoLineAllocation();
  const deleteAlloc = useDeletePoLineAllocation();
  const busy = addAlloc.isPending || updateAlloc.isPending || deleteAlloc.isPending;

  // New-slice draft (the only client-side state; existing rows edit in place).
  const [newQty, setNewQty] = useState("1");
  const [newTarget, setNewTarget] = useState<string>(STOCK);
  // Per-row dirty drafts for existing slices: allocationId -> { qty, target }.
  const [rowDrafts, setRowDrafts] = useState<Record<string, { qty: string; target: string }>>({});

  const draftOf = (a: PoLineAllocation) =>
    rowDrafts[a.id] ?? { qty: String(a.qty), target: a.so_item_id ?? STOCK };
  const setRowDraft = (a: PoLineAllocation, patch: Partial<{ qty: string; target: string }>) =>
    setRowDrafts((prev) => ({ ...prev, [a.id]: { ...draftOf(a), ...patch } }));
  const rowDirty = (a: PoLineAllocation) => {
    const d = draftOf(a);
    return Number(d.qty) !== Number(a.qty) || (d.target || null) !== (a.so_item_id ?? null);
  };

  const doAdd = async () => {
    if (!line) return;
    try {
      await addAlloc.mutateAsync({
        poId,
        itemId: line.id,
        qty: Number(newQty),
        soItemId: newTarget || null,
      });
      setNewQty("1");
      setNewTarget(STOCK);
    } catch (e) {
      notify({ title: "Could not add the allocation", body: plainError(e), tone: "error" });
    }
  };

  const doSaveRow = async (a: PoLineAllocation) => {
    if (!line) return;
    const d = draftOf(a);
    try {
      await updateAlloc.mutateAsync({
        poId,
        itemId: line.id,
        allocationId: a.id,
        qty: Number(d.qty),
        soItemId: d.target || null,
      });
      setRowDrafts((prev) => {
        const { [a.id]: _gone, ...rest } = prev;
        return rest;
      });
    } catch (e) {
      notify({ title: "Could not save the allocation", body: plainError(e), tone: "error" });
    }
  };

  const doDelete = async (a: PoLineAllocation) => {
    if (!line) return;
    try {
      await deleteAlloc.mutateAsync({ poId, itemId: line.id, allocationId: a.id });
    } catch (e) {
      notify({ title: "Could not remove the allocation", body: plainError(e), tone: "error" });
    }
  };

  const inputCls =
    "w-full rounded-md border border-border bg-surface px-2 py-1 font-money text-[12.5px] text-ink outline-none focus:border-primary/60";
  const selectCls =
    "w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-primary/60";

  const targetOptions = (
    <>
      <option value={STOCK}>STOCK — no customer</option>
      {(candidates.data ?? []).map((cand) => (
        <option key={cand.soItemId} value={cand.soItemId}>
          {cand.soDocNo}
          {cand.debtorName ? ` · ${cand.debtorName}` : ""}
          {` · qty ${cand.qty}`}
          {cand.deliveryDate ? ` · ${formatDate(cand.deliveryDate)}` : ""}
        </option>
      ))}
    </>
  );

  return (
    <ModalOverlay
      open
      onClose={onClose}
      title={`Allocations · ${line?.material_code ?? ""}`}
      icon={<Split size={16} />}
      size="lg"
      footer={
        <>
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Done
          </Button>
        </>
      }
    >
      {detail.isPending ? (
        <div className="py-8 text-center text-[13px] text-ink-muted">Loading line…</div>
      ) : !line ? (
        <div className="py-8 text-center text-[13px] text-err">This line no longer exists on the purchase order.</div>
      ) : (
        <div className="space-y-4">
          <p className="text-[12px] text-ink-secondary">
            Split this line across the Sales Orders it was bought for — one consolidated purchase can
            serve several customers plus stock. Each slice gets a sub-number of{" "}
            <span className="font-mono font-semibold text-ink">{poNumber}</span>. Where allocations
            exist they are the authoritative answer for this line's Assigned SO.
          </p>

          {/* The cap, stated up front: ordered / allocated / room left. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-[12px]">
            <span className="min-w-0">
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">Line</span>{" "}
              <span className="font-mono font-semibold text-ink">{line.material_code}</span>
            </span>
            <span>
              <span className="text-ink-muted">Ordered</span>{" "}
              <span className="font-money font-semibold text-ink">{lineQty}</span>
            </span>
            <span>
              <span className="text-ink-muted">Allocated</span>{" "}
              <span className="font-money font-semibold text-ink">{allocated}</span>
            </span>
            <span>
              <span className="text-ink-muted">Unallocated</span>{" "}
              <span className={`font-money font-semibold ${remaining > 0 ? "text-accent-bright" : "text-synced"}`}>
                {remaining}
              </span>
            </span>
          </div>

          {/* Existing slices — each row edits in place (qty, target), deletes. */}
          <div className="space-y-2">
            {allocations.map((a) => {
              const d = draftOf(a);
              return (
                <div key={a.id} className="rounded-md border border-border px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="shrink-0 rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent-ink"
                      title={`Allocation ${subNumberOf(poNumber, a.seq)}`}
                    >
                      {subNumberOf(poNumber, a.seq)}
                    </span>
                    <div className="w-20 shrink-0">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className={inputCls}
                        value={d.qty}
                        aria-label={`Qty for ${subNumberOf(poNumber, a.seq)}`}
                        onChange={(e) => setRowDraft(a, { qty: e.target.value })}
                      />
                    </div>
                    <div className="min-w-[200px] flex-1">
                      <select
                        className={selectCls}
                        value={d.target}
                        aria-label={`Sales Order for ${subNumberOf(poNumber, a.seq)}`}
                        onChange={(e) => setRowDraft(a, { target: e.target.value })}
                      >
                        {/* A historical target that fell out of the candidate list
                            (e.g. its SO was cancelled later) still renders. */}
                        {a.so_item_id && !(candidates.data ?? []).some((cand) => cand.soItemId === a.so_item_id) && (
                          <option value={a.so_item_id}>{a.so_doc_no ?? a.so_item_id}</option>
                        )}
                        {targetOptions}
                      </select>
                    </div>
                    {rowDirty(a) && (
                      <Button variant="secondary" onClick={() => void doSaveRow(a)} disabled={busy}>
                        Save
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => void doDelete(a)}
                      disabled={busy}
                      aria-label={`Remove ${subNumberOf(poNumber, a.seq)}`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-err/40 bg-err/5 text-err hover:bg-err/10 disabled:opacity-40"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
            {allocations.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-[12px]">
                {/* Show the EFFECTIVE assignment, not an empty state — the coarse
                    Source-SO link governs the whole line until a slice overrides
                    it, and "no allocations" beside a visible Assigned SO read as a
                    contradiction (owner, 2026-08-06). */}
                <div className="flex items-center gap-2">
                  <span className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-ink-secondary">
                    {line?.so_doc_no ?? 'STOCK'}
                  </span>
                  <span className="text-ink-muted">
                    whole line (qty {line?.qty ?? 0}) — implicit, via its Source SO link{line?.so_doc_no ? '' : ' (none)'}.
                    Adding a first slice overrides this.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Add a slice */}
          <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5">
            <div className="mb-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">
              Add allocation {allocations.length > 0 ? subNumberOf(poNumber, allocations.length + 1) : subNumberOf(poNumber, 1)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-20 shrink-0">
                <input
                  type="number"
                  min={1}
                  step={1}
                  max={remaining > 0 ? remaining : undefined}
                  className={inputCls}
                  value={newQty}
                  aria-label="Qty for the new allocation"
                  onChange={(e) => setNewQty(e.target.value)}
                />
              </div>
              <div className="min-w-[200px] flex-1">
                <select
                  className={selectCls}
                  value={newTarget}
                  aria-label="Sales Order for the new allocation"
                  onChange={(e) => setNewTarget(e.target.value)}
                >
                  {targetOptions}
                </select>
              </div>
              <Button
                variant="primary"
                icon={<Plus size={13} />}
                onClick={() => void doAdd()}
                disabled={busy || remaining <= 0}
              >
                Add
              </Button>
            </div>
            {remaining <= 0 && allocations.length > 0 && (
              <div className="mt-1.5 text-[11px] text-ink-muted">
                Fully allocated — free up qty on an existing slice to add another.
              </div>
            )}
            {candidates.isError && (
              <div className="mt-1.5 text-[11px] text-err">
                Couldn't load the Sales Order lines for {line.material_code} — STOCK still works; reopen to retry.
              </div>
            )}
          </div>
        </div>
      )}
    </ModalOverlay>
  );
}

export default PoLineAllocationsModal;
