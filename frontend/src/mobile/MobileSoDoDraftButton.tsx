import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders } from "../auth/salesAccess";
import { soOffersTransferToDo, CONVERT_TO_DO_DRAFT_LABEL } from "../lib/so-transfer-to-do";
import { useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { useNotify } from "../vendor/scm/components/NotifyDialog";
import { useConvertSoToDoDraft } from "../vendor/scm/lib/delivery-order-queries";
import { invalidateConvertShared, invalidateMobileLists } from "./sharedInvalidate";

/* The phone's "Convert to DO Draft" (owner 2026-11-18): the desktop right-click's
   twin, through the same shared hook. A DRAFT DO for every line still to
   deliver; no stock moves and nothing is asked about stock until Confirm.
   ABSENT (not disabled) where the desktop entry is absent. */
export function MobileSoDoDraftButton({ so, onCreated }: {
  so: { doc_no: string; status?: string | null; on_hold?: boolean | null; has_undelivered?: boolean | null };
  onCreated: ((doId: string) => void) | null;
}) {
  const { user, can, pageAccess } = useAuth();
  const confirm = useConfirm();
  const notify = useNotify();
  const qc = useQueryClient();
  const convert = useConvertSoToDoDraft();
  if (!canOperateDeliveryOrders(user, can, pageAccess) || !soOffersTransferToDo(so)) return null;

  const run = async () => {
    if (!(await confirm({ title: `Open a draft delivery order for ${so.doc_no}?`, body: "Every line still to deliver goes on one DRAFT delivery order. No stock moves and nothing is asked about stock until you press Confirm on it.", confirmLabel: "Create DO Draft" }))) return;
    convert.mutate(so.doc_no, {
      onSuccess: (res) => {
        invalidateConvertShared(qc);
        invalidateMobileLists(qc);
        void notify({ title: `Draft ${res.doNumber} created`, body: "Press Confirm on it once the goods are in; that is when the stock leaves." });
        if (onCreated && res.id) onCreated(res.id);
      },
      onError: (e) => void notify({ title: "Draft delivery order not created", body: e instanceof Error ? e.message : "Something went wrong.", tone: "error" }),
    });
  };
  return (
    <button type="button" className="btn-ghost" style={{ width: "100%", marginTop: 9, opacity: convert.isPending ? 0.55 : 1 }} disabled={convert.isPending} onClick={() => void run()}>
      {convert.isPending ? "Working…" : CONVERT_TO_DO_DRAFT_LABEL}
    </button>
  );
}
