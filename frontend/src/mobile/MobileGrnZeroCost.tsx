/* ── The zero-cost receipt remedy, ON THE PHONE ──────────────────────────────
   THE GAP THIS CLOSES. `PATCH /scm/grns/:id/post` refuses a receipt that would
   open a zero-cost stock layer for a SKU the system has already seen carry
   money, and the refusal is a good one: it names the offending lines, what each
   item normally costs, and the two ways out — enter the unit price from the
   supplier's goods-received document, or tick "Received free" on that line.
   Desktop has both controls on `GoodsReceivedDetail`. Mobile had NEITHER: the
   receipt screen offered "Post" and "Cancel", `zeroCostAck` appeared nowhere in
   `frontend/src/mobile`, and the convert wizard's own copy of the message told
   the receiver to "open the receipt on desktop". A receiver on the warehouse
   floor got a correct, readable refusal naming two fixes and had to go find a
   PC. The refusal itself already rendered fine on both surfaces — the gap was
   the remedy.

   WHAT IT DELIBERATELY IS NOT. There is no "waive this receipt" button. Every
   line is its own decision, exactly as on desktop: a price, or a tick that
   carries a reason. "One click waiving a whole receipt is the reflex the gate
   exists to prevent" (docs/modules/grn.md, "How an operator clears the
   refusal"), and it is why the escape hatch lives on the line and not on the
   dialog.

   The two writes are the SAME routes desktop uses — `PATCH /grns/:id/items/
   :itemId` carries `unitPriceSen` and/or `zeroCostAck` + `zeroCostReason` (the
   only route that clears the gate without inventing a price; the three ack
   columns move together server-side through `zeroCostAckColumns`), then the
   original `PATCH /grns/:id/post` runs again. Nothing about the RULE is
   re-implemented here. */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { authedFetch } from "../vendor/scm/lib/authed-fetch";
import {
  zeroCostRefusalFrom,
  zeroCostRefusalText,
  type ZeroCostRefusal,
  type ZeroCostRefusalLine,
} from "../vendor/scm/lib/zero-cost-refusal";

/** What the operator decided about ONE refused line. */
type Decision = { price: string; ack: boolean; reason: string };

const blank = (): Decision => ({ price: "", ack: false, reason: "" });

/** A line is answered once it carries a real price OR an explicit "received
 *  free" tick. This mirrors the server's own condition, said one round-trip
 *  earlier — the same posture as the SO form's pre-checks. */
export function lineIsAnswered(d: Decision): boolean {
  return d.ack || Math.round(Number(d.price) * 100) > 0;
}

const senOf = (price: string): number | null => {
  const sen = Math.round(Number(price) * 100);
  return Number.isFinite(sen) && sen > 0 ? sen : null;
};

const rm = (sen: number): string => `RM${(sen / 100).toFixed(2)}`;

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", height: 40, padding: "0 11px", borderRadius: 10,
  border: "1px solid #e3e6e0", background: "#fff", fontFamily: "inherit", fontSize: 14, color: "var(--ink)",
};
const labelStyle: React.CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase",
  color: "#9aa093", marginBottom: 5, display: "block",
};

/**
 * The bottom sheet the refusal opens. One card per refused line; Post again
 * runs only once every line has been answered.
 */
export function MobileGrnZeroCostSheet({ grnId, refusal, onClose, onPosted }: {
  grnId: string;
  refusal: ZeroCostRefusal;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [error, setError] = useState<string | null>(null);

  const keyOf = (l: ZeroCostRefusalLine, i: number) => l.id ?? `no-id-${i}`;
  const decisionOf = (k: string): Decision => decisions[k] ?? blank();
  const patchDecision = (k: string, patch: Partial<Decision>) =>
    setDecisions((prev) => ({ ...prev, [k]: { ...(prev[k] ?? blank()), ...patch } }));

  /* A line the server named but could not identify cannot be PATCHed from here.
     It has never been observed (the guard reads grn_items.id), and saying so is
     better than a control that silently writes nothing. */
  const unaddressable = refusal.lines.filter((l) => !l.id);
  const answerable = refusal.lines.filter((l) => l.id);
  const allAnswered =
    answerable.length > 0
    && unaddressable.length === 0
    && answerable.every((l, i) => lineIsAnswered(decisionOf(keyOf(l, i))));

  const submit = useMutation({
    mutationFn: async () => {
      for (const [i, line] of refusal.lines.entries()) {
        if (!line.id) continue;
        const d = decisionOf(keyOf(line, i));
        const body: Record<string, unknown> = {};
        const sen = senOf(d.price);
        if (sen != null) body.unitPriceSen = sen;
        if (d.ack) {
          body.zeroCostAck = true;
          body.zeroCostReason = d.reason.trim() || null;
        }
        if (Object.keys(body).length === 0) continue;
        await authedFetch(
          `/grns/${encodeURIComponent(grnId)}/items/${encodeURIComponent(line.id)}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
      }
      /* Same call the footer's Post button makes. A second zero-cost refusal is
         possible (a price typed as 0 on a line that was then not ticked) and it
         surfaces here as its own sentence rather than as a dead end. */
      await authedFetch(`/grns/${encodeURIComponent(grnId)}/post`, { method: "PATCH" });
    },
    onSuccess: () => { onPosted(); onClose(); },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't post the goods receipt. Please try again."),
  });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 2500, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "flex-end" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="hz-m"
        role="dialog"
        aria-label="Receipt needs a cost"
        style={{ width: "100%", maxHeight: "86vh", overflowY: "auto", background: "#fff", borderRadius: "18px 18px 0 0", padding: "18px 16px calc(env(safe-area-inset-bottom) + 16px)", boxShadow: "0 -8px 28px rgba(0,0,0,0.16)" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>Receipt needs a cost</div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: "var(--teal)", cursor: "pointer", fontFamily: "inherit" }}>Close</button>
        </div>

        {/* The server's own words, unedited — the same sentence the desktop
            Confirm shows, so the two surfaces cannot explain it differently. */}
        <p style={{ margin: "0 0 14px", fontSize: 12, lineHeight: 1.55, color: "#6b7280", whiteSpace: "pre-wrap" }}>
          {zeroCostRefusalText(refusal)}
        </p>

        {unaddressable.length > 0 && (
          <p style={{ margin: "0 0 14px", fontSize: 12, lineHeight: 1.5, color: "#b23a3a" }}>
            {unaddressable.length} refused line{unaddressable.length === 1 ? "" : "s"} came back without a line id, so
            {unaddressable.length === 1 ? " it" : " they"} cannot be corrected from here. Open this receipt on desktop.
          </p>
        )}

        {answerable.map((line, i) => {
          const k = keyOf(line, i);
          const d = decisionOf(k);
          return (
            <div key={k} style={{ border: "1px solid #e3e6e0", borderRadius: 12, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{line.itemCode} × {line.qtyAccepted}</div>
              <div style={{ fontSize: 11, color: "#767b6e", marginBottom: 10 }}>
                normally about {rm(line.knownUnitCostSen)} each
              </div>

              <label style={{ display: "block", marginBottom: 10 }}>
                <span style={labelStyle}>Unit price (RM)</span>
                <input
                  aria-label={`Unit price for ${line.itemCode}`}
                  inputMode="decimal"
                  value={d.price}
                  disabled={d.ack || submit.isPending}
                  placeholder="From the supplier's goods-received document"
                  onChange={(e) => patchDecision(k, { price: e.target.value })}
                  style={{ ...inputStyle, opacity: d.ack ? 0.5 : 1 }}
                />
              </label>

              {/* Per line, and it carries a reason — see the header note. */}
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink)" }}>
                <input
                  type="checkbox"
                  aria-label={`Received free: ${line.itemCode}`}
                  checked={d.ack}
                  disabled={submit.isPending}
                  onChange={(e) => patchDecision(k, { ack: e.target.checked })}
                />
                Received free
              </label>
              {d.ack && (
                <input
                  aria-label={`Why free: ${line.itemCode}`}
                  value={d.reason}
                  disabled={submit.isPending}
                  placeholder="Why free? e.g. GWP, demo unit"
                  onChange={(e) => patchDecision(k, { reason: e.target.value })}
                  style={{ ...inputStyle, marginTop: 8 }}
                />
              )}
            </div>
          );
        })}

        {error && (
          <div style={{ fontSize: 11.5, color: "#b23a3a", marginBottom: 12, whiteSpace: "pre-wrap" }}>{error}</div>
        )}

        {!allAnswered && unaddressable.length === 0 && (
          <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "#767b6e", textAlign: "center" }}>
            Give every line above a unit price, or tick "Received free" on it.
          </p>
        )}

        <button
          className="btn"
          disabled={!allAnswered || submit.isPending}
          onClick={() => { setError(null); submit.mutate(); }}
          style={{ opacity: !allAnswered || submit.isPending ? 0.55 : 1 }}
        >
          {submit.isPending ? "Posting…" : "Save costs & post"}
        </button>
      </div>
    </div>
  );
}

/**
 * Wire the remedy into a document screen without teaching that screen the rule.
 *
 * `capture(err)` returns true when the error IS a zero-cost refusal — the caller
 * then suppresses its own inline message, because the sheet says the same thing
 * and can act on it. Anything else returns false and is handled as before.
 */
export function useGrnZeroCostRemedy({ grnId, onPosted }: { grnId: string; onPosted: () => void }) {
  const [refusal, setRefusal] = useState<ZeroCostRefusal | null>(null);
  return {
    capture: (err: unknown): boolean => {
      const parsed = zeroCostRefusalFrom(err);
      if (!parsed) return false;
      setRefusal(parsed);
      return true;
    },
    sheet: refusal
      ? (
        <MobileGrnZeroCostSheet
          grnId={grnId}
          refusal={refusal}
          onClose={() => setRefusal(null)}
          onPosted={onPosted}
        />
      )
      : null,
  };
}
