/* THE PHONE'S DELIVERY LADDER MAY NOT NAME A SIGNATURE EITHER.
 *
 * Owner, 2026-08-21: 「签收签名不需要 先 delete掉」 — the customer signature is
 * retired. `docs/bugs/0481-mark-signed-on-the-mobile-shell-closes-a-delivery-with-no-si.md`
 * had already recorded what this control does: the `IN_TRANSIT` rung is
 * labelled "Mark Signed", writes the status and nothing else — no signature, no
 * photo, no GPS — and `SIGNED` counts as delivered everywhere downstream (it is
 * in the `delivered` list bucket, `doCountsAsDelivered` returns true for it, and
 * it satisfies the Sales-Invoice gate).
 *
 * That entry left the fix as an owner question because both candidate remedies
 * REMOVE an action drivers may be using. The ruling does not answer that
 * question, so the rung stays and only the WORDS change: with no signature
 * anywhere in the product, a control called "Mark Signed" names evidence that
 * cannot exist. What it actually does for the operator is close the delivery,
 * which is what it now says.
 *
 * DELIBERATELY NOT ASSERTED HERE: that the rung writes `DELIVERED`. It still
 * writes `SIGNED`, and changing that contradicts a decision recorded in
 * `MobileModuleDetail.tsx` ("DELIVERED is the POD screen's job, so it is never
 * offered here") plus the guard on the line above the table. Unifying the two is
 * the owner question 0481 raised and this PR does not settle it — so the test
 * pins the CURRENT target on purpose, and a future change to it is a decision
 * somebody has to make here rather than a silent drift.
 */
import { describe, expect, it } from "vitest";

import { statusActionsFor } from "./MobileModuleDetail";
// @ts-expect-error — .mjs constants module, no types, deliberately not vendored.
import { DO_SHIPPED_STATES } from "../../../backend/scripts/lib/do-shipped-states.mjs";

/* DERIVED, never hand-typed — the status vocabulary has been hand-copied into
   eleven files here and two of the copies had already drifted. Sweeping the
   WHOLE enum is also stricter than listing the rungs that happen to have an
   entry today: a status added to the ladder later is swept on arrival. */
const ALL_DO_STATUSES: string[] = [
  ...(DO_SHIPPED_STATES as string[]),
  "DRAFT",
  "LOADED",
  "CANCELLED",
];

/** The delivery-order action bar as the phone builds it for one status. */
function doActions(status: string) {
  return statusActionsFor("delivery-orders-mfg", "do-uuid-1", { status }, true);
}

describe("the mobile shell's delivery-order ladder", () => {
  it("names the closing rung for what it does, not for a signature", () => {
    const next = doActions("IN_TRANSIT").find((a) => a.key === "next");
    expect(next).toBeTruthy();
    expect(next!.label).toBe("Mark delivered");
  });

  it("no delivery-order control on this surface says 'signed'", () => {
    // "" is the absent-status case the ladder also has a rung for, so it is
    // swept alongside the eight real ones.
    for (const status of ["", ...ALL_DO_STATUSES]) {
      for (const action of doActions(status)) {
        expect(action.label, `${status} → ${action.label}`).not.toMatch(/sign/i);
      }
    }
  });

  it("still closes the delivery — the rung is renamed, never removed", () => {
    /* The half of 0481 this PR does NOT take: dropping the rung would remove an
       action drivers may rely on, which is the owner's call. */
    const next = doActions("IN_TRANSIT").find((a) => a.key === "next");
    expect(next!.request.method).toBe("PATCH");
    expect(next!.request.body).toEqual({ status: "SIGNED" });
  });

  it("leaves the earlier rungs alone", () => {
    expect(doActions("DRAFT").find((a) => a.key === "next")?.label).toBe("Confirm");
    expect(doActions("DISPATCHED").find((a) => a.key === "next")?.label).toBe("Mark In Transit");
  });
});
