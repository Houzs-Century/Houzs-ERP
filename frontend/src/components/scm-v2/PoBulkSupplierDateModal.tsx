// ----------------------------------------------------------------------------
// PoBulkSupplierDateModal — set ONE supplier-revised delivery date slot across a
// picked set of Purchase Orders, via POST /mfg-purchase-orders/bulk-supplier-date.
//
// Why it exists (owner 2026-08-03): a supplier who pushes a delivery date almost
// never pushes it for one order — they push it for everything in flight. Before
// this, that meant opening each PO and (before the sibling change to the PO
// editor) each LINE inside it. Here the operator ticks the POs in the list, picks
// the slot + date once, and the server fans it down.
//
// "Also update every line" defaults ON because leaving the lines behind is what
// made this tedious — but it stays a checkbox, since the header-only move is the
// right call when a PO's lines are individually managed.
//
// A recorded date is history (DEV-73): the server never overwrites a filled
// slot, so the dialog shows every ticked PO's Date 1-4, defaults to "next empty
// date" (each PO gets its own), and disables a slot every ticked PO has filled.
//
// The server isolates each PO: locked ones (a Goods Receipt exists) and ones
// outside the active company come back in `skipped` with a reason instead of
// failing the batch, so this reports a partial result honestly rather than
// claiming a clean sweep.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { ModalOverlay } from "./DocumentRelationshipMapModal";
import { Button } from "../Button";
import { authedFetch, humanApiError } from "../../vendor/scm/lib/authed-fetch";
import { DateField } from "../../vendor/scm/components/DateField";
import type { PoHeaderRow } from "../../vendor/scm/lib/suppliers-queries";
import { fmtDate } from "@2990s/shared";

/* Same unwrap PoAmendmentCreateModal uses: authedFetch's rejection carries the
   raw status + body, which humanApiError turns into a sentence. */
const plainError = (e: unknown): string => {
  const err = e as { status?: number; body?: string; message?: string };
  if (typeof err?.status === "number" && typeof err?.body === "string") {
    return humanApiError(err.status, err.body);
  }
  return err?.message ?? "Something went wrong. Please try again.";
};

/** The three supplier-revised slots on a PO (mig 0026 / 0180). */
export type SupplierDateSlot = 2 | 3 | 4;

export type BulkSupplierDateResult = {
  slot: SupplierDateSlot | "next";
  date: string;
  applyToLines: boolean;
  updated: Array<{ id: string; poNumber: string | null; slot: SupplierDateSlot }>;
  skipped: Array<{ id: string; poNumber: string | null; reason: string }>;
};

export function PoBulkSupplierDateModal({
  open,
  poIds,
  pos,
  onClose,
  onDone,
}: {
  open: boolean;
  /** The POs ticked in the list. */
  poIds: string[];
  /** The ticked rows on this page, for the read-only Date 1-4 table. */
  pos: PoHeaderRow[];
  onClose: () => void;
  /** Fired after a successful call so the caller can refetch + report. */
  onDone: (result: BulkSupplierDateResult) => void;
}) {
  const [slot, setSlot] = useState<SupplierDateSlot | "next">("next");
  const [date, setDate] = useState("");
  const [applyToLines, setApplyToLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh inputs each time it opens — a date left over from the previous batch
  // is the kind of thing that quietly gets applied to the wrong set of POs.
  useEffect(() => {
    if (!open) return;
    setSlot("next");
    setDate("");
    setApplyToLines(true);
    setError(null);
    setBusy(false);
  }, [open]);

  const submit = async () => {
    if (!date || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authedFetch<BulkSupplierDateResult>(
        "/mfg-purchase-orders/bulk-supplier-date",
        {
          method: "POST",
          body: JSON.stringify({ poIds, slot, date, applyToLines }),
        }
      );
      onDone(result);
      onClose();
    } catch (e) {
      setError(`${plainError(e)} Nothing was changed — please try again.`);
    } finally {
      setBusy(false);
    }
  };

  const count = poIds.length;
  const slotDate = (r: PoHeaderRow, s: SupplierDateSlot) => r[`supplier_delivery_date_${s}`] || null;
  const filledForAll = (s: SupplierDateSlot) => pos.length > 0 && pos.every((r) => slotDate(r, s));
  const slotButton = (active: boolean) =>
    active
      ? "flex-1 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-[13px] font-semibold text-primary"
      : "flex-1 rounded-lg border border-border px-3 py-2 text-[13px] text-ink hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <ModalOverlay
      open={open}
      onClose={onClose}
      title="Set supplier delivery date"
      icon={<CalendarClock size={16} />}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!date || busy}>
            {busy ? "Applying…" : `Apply to ${count} ${count === 1 ? "PO" : "POs"}`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-[13px]">
        <p className="text-ink-muted">
          Sets one supplier-revised date on{" "}
          <strong className="text-ink">
            {count} selected {count === 1 ? "purchase order" : "purchase orders"}
          </strong>
          . Purchase orders with a Goods Receipt, or whose chosen date is already
          recorded, are skipped and listed after.
        </p>

        {pos.length > 0 && (
          <div className="max-h-48 overflow-auto rounded-lg border border-border">
            <table className="w-full text-[12px]">
              <thead className="text-left text-ink-muted">
                <tr>
                  <th className="px-2 py-1 font-semibold">PO</th>
                  <th className="px-2 py-1 font-semibold">Date 1</th>
                  <th className="px-2 py-1 font-semibold">Date 2</th>
                  <th className="px-2 py-1 font-semibold">Date 3</th>
                  <th className="px-2 py-1 font-semibold">Date 4</th>
                </tr>
              </thead>
              <tbody>
                {pos.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-2 py-1 font-medium text-ink">{r.po_number}</td>
                    <td className="px-2 py-1">{r.expected_at ? fmtDate(r.expected_at) : "—"}</td>
                    {([2, 3, 4] as const).map((s) => {
                      const d = slotDate(r, s);
                      return <td key={s} className="px-2 py-1">{d ? fmtDate(d) : "—"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Which date
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSlot("next")}
              aria-pressed={slot === "next"}
              className={slotButton(slot === "next")}
            >
              Next empty date
            </button>
            {([2, 3, 4] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSlot(s)}
                aria-pressed={slot === s}
                disabled={filledForAll(s)}
                title={filledForAll(s) ? `Supplier Date ${s} is already recorded on every ticked PO` : undefined}
                className={slotButton(slot === s)}
              >
                Supplier Date {s}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            New date
          </span>
          <DateField
            fullWidth
            value={date}
            onChange={(iso) => setDate(iso)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary"
          />
        </label>

        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={applyToLines}
            onChange={(e) => setApplyToLines(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-semibold text-ink">Also update every line</span>
            <span className="block text-[12px] text-ink-muted">
              Overwrites this slot on all lines, including lines that already have a
              date. Leave off to move only the PO header.
            </span>
          </span>
        </label>

        {error && (
          <div className="rounded-lg border border-[#B71C1C]/35 bg-[#B71C1C]/[0.07] px-3 py-2 text-[12px] text-[#B71C1C]">
            {error}
          </div>
        )}
      </div>
    </ModalOverlay>
  );
}
