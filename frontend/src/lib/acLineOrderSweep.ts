// ----------------------------------------------------------------------------
// The line-order sweep, reachable at last.
//
// `POST /scm/autocount-outbox/line-order-sweep` was written after the owner
// found three migrated documents one at a time — lines in a different order
// from the ERP's, and on SO-013361 a line he had deleted still sitting in the
// book at Qty 0 — and said 「之后有问题吗？我不要每次都来 fix 啊」. It measures
// the whole population instead of waiting for him to open the next one.
//
// IT WAS BUILT AND NEVER WIRED UP. Measured 2026-09-09: no workflow calls it and
// no screen calls it, so nothing has ever run it. It cannot be a workflow — it
// reads the LIVE account book through the host, whose credentials are Worker
// secrets and must never become Actions secrets — so a button is the only place
// it can live. This is that button's client.
//
// The question it answers that nothing else can: HC-SO-010741's ERP lines carry
// keys 927780..927783, and the book's own SO-010741 holds 751034..751037. Those
// 927xxx keys appear nowhere in the committed cutover snapshot, so only a live
// read can say which side is stale.
//
// READ-ONLY ON BOTH SIDES. One SELECT on the account book, a handful of paged
// SELECTs here. It says WHICH documents to rebuild; the rebuilding stays a
// separate, deliberate act.
// ----------------------------------------------------------------------------
import { api } from "../api/client";
import { useQuery } from "../hooks/useQuery";

/** One document's answer. `verdict` is the sweep's own vocabulary. */
export interface AcSweepRow {
  docNo: string;
  verdict: string;
  bookLines: number | null;
  erpLines: number | null;
}

export interface AcLineOrderSweepResponse {
  ok: boolean;
  docType: string;
  bookDocuments: number;
  /** The book read hit its own page ceiling, so the answer is PARTIAL. */
  bookTruncated: boolean;
  total: number;
  byVerdict: Record<string, number>;
  failing: AcSweepRow[];
}

export const AC_SWEEP_TITLE = "Do the account book's lines still match ours?";
export const AC_SWEEP_BLURB =
  "Reads the live account book and compares every document's lines with the ERP's. "
  + "Read-only — it names the documents to look at, and changes nothing.";
export const AC_SWEEP_RUN = "Run the sweep";
export const AC_SWEEP_BUSY = "Reading the account book…";

export async function runAcLineOrderSweep(): Promise<AcLineOrderSweepResponse> {
  return api.post<AcLineOrderSweepResponse>("/api/scm/autocount-outbox/line-order-sweep", {});
}

/**
 * The sweep, ON DEMAND and never on page load.
 *
 * `enabled` is required for the same reason the host log's is: this is a round
 * trip through a Cloudflare tunnel to a desktop PC in the office, and a panel
 * that swept whenever the Sync page opened would put that machine on the
 * critical path of a page every staff member loads. Heavy reads there also
 * starve the write-back — a wide scan makes SalesOrder.InternalSave time out,
 * and the 500 looks exactly like a permissions refusal.
 */
export function useAcLineOrderSweep(enabled: boolean) {
  return useQuery<AcLineOrderSweepResponse>(
    "/api/scm/autocount-outbox/line-order-sweep",
    runAcLineOrderSweep,
    [enabled],
    { enabled },
  );
}

/**
 * The one line a reader needs before any table.
 *
 * A TRUNCATED read is called out first and in its own words, because a partial
 * sweep that reports "12 documents disagree" reads exactly like a complete one
 * that found 12 — and the difference is whether the rest were checked at all.
 */
export function acSweepHeadline(r: AcLineOrderSweepResponse | undefined): string {
  if (!r) return "";
  if (r.bookTruncated) {
    return `PARTIAL — the account book read hit its page limit, so only ${r.total} document(s) `
      + "were compared. Treat the count below as a floor, not a total.";
  }
  const bad = r.failing.length;
  if (!bad) return `All ${r.total} document(s) compared, and every one's lines match the ERP.`;
  return `${r.total} document(s) compared. ${bad} need looking at.`;
}
