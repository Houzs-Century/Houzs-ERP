// so-share-queries — grant or withdraw access on ONE Sales Order from its
// detail screen (desktop + mobile).
//
// Owner 2026-09-28: sharing lived only on SO Maintenance → Salesperson
// Handover, which acts on EVERY order a salesperson holds. Sharing two orders
// with one colleague meant sharing all 185. This reuses the same endpoint with
// a one-order docNos list, so the permission (scm.so.attribute_other), the
// audit row and the "already shared" skip are the server's, not re-derived here.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authedFetch } from "./authed-fetch";

type ShareResponse = {
  changed?: Array<{ docNo: string }>;
  skipped?: Array<{ docNo: string; reason: string }>;
};

export type ShareVars = {
  docNo: string;
  staffId: string;
  mode: "add" | "remove";
};

export function useShareSalesOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docNo, staffId, mode }: ShareVars) => {
      const res = await authedFetch<ShareResponse>("/so-handover/share", {
        method: "POST",
        body: JSON.stringify({ staffIds: [staffId], docNos: [docNo], mode }),
      });
      /* A 200 with the order in `skipped` is still a refusal for this screen:
         the operator asked about exactly one order, so say why it did not
         change rather than showing a success that did not happen. */
      const skip = (res.skipped ?? []).find((s) => s.docNo === docNo);
      if (skip) throw new Error(skip.reason);
      return res;
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ["mfg-sales-order-detail", vars.docNo] });
    },
  });
}
