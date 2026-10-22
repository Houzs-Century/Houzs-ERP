// ─────────────────────────────────────────────────────────────────────────
// productRequestNotify.ts — the Purchaser's notice that a product request is
// waiting for a decision.
//
// HC-0136 (Sim, 2026-10-20): 「product request have notification alert when
// have new request order. same like SO amendment」. So it follows the SO
// amendment notice exactly: a private announcement (the bell's system slice)
// to every active holder of `scm.product_request.approve` in the request's
// company, LITERAL holders only — the `*` roles see every request inside the
// module and would otherwise get every notice ever raised (permissionHolders.ts).
//
// Raised and resubmitted (a rejected request sent again) both put it back on
// the Purchaser's desk, so both notify. The requester is never told about
// their own request.
//
// NEVER THROWS. A notify failure must not fail the request write behind it.
// ─────────────────────────────────────────────────────────────────────────

import type { Env } from "../types";
import { usersHoldingPermission } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";

const SOURCE = "product_request";
export const PRODUCT_REQUEST_APPROVE_PERM = "scm.product_request.approve";

export type ProductRequestNotifyEvent = "raised" | "resubmitted";

export type ProductRequestNotifyOpts = {
  requestNo: string;
  companyId: number | string | null;
  requesterUserId: number | null;
  requesterName: string | null;
  /** Already summarised, e.g. "Aurora (new) ×2; 5530-3S ×1". */
  products: string;
  lineCount: number;
};

const clip = (s: string): string => {
  const r = s.replace(/\s+/g, " ").trim();
  return r.length > 200 ? `${r.slice(0, 199)}…` : r;
};

export async function notifyProductRequest(env: Env, event: ProductRequestNotifyEvent, opts: ProductRequestNotifyOpts): Promise<void> {
  try {
    const requester = Number(opts.requesterUserId) || 0;
    const audience = (await usersHoldingPermission(env, PRODUCT_REQUEST_APPROVE_PERM, { companyId: opts.companyId }))
      .filter((id) => id !== requester);
    if (audience.length === 0) return;
    const by = (opts.requesterName ?? "").trim();
    const lines = `${opts.lineCount} line${opts.lineCount === 1 ? "" : "s"}`;
    await postPersonalNotice(env, {
      userIds: audience,
      category: "GENERAL",
      title: `${opts.requestNo} — product request needs approval`,
      body: event === "raised"
        ? `A new product request${by ? ` from ${by}` : ""} is waiting for approval (${lines}: ${clip(opts.products)}).`
        : `A rejected product request was changed and sent again${by ? ` by ${by}` : ""} (${lines}: ${clip(opts.products)}).`,
      source: SOURCE,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[productRequestNotify] notify failed:", err);
  }
}
