import { useOrderMoney, useConvertSources } from "../../vendor/scm/lib/so-money-queries";
import { useCancelRequest } from "../../vendor/scm/lib/document-cancel-queries";
import { useSoBackdateRequests } from "../../vendor/scm/lib/payment-backdate-queries";
import { useRefundSource } from "../../vendor/scm/lib/payment-voucher-queries";
import { useDocumentFlow } from "../../vendor/scm/lib/flow-queries";
import { useSoDropdownOptions } from "../../vendor/scm/lib/so-dropdown-options-queries";
import { useRacks } from "../../vendor/scm/lib/warehouse-queries";

/* HC-0002. The detail pages render their panels only after the header read
   lands, so each panel's own read started a wave later (prod 2026-10-22: SO
   money / convert-sources / document-flow began at ~1.2s, DO document-flow at
   ~0.8s). These call the SAME hooks the panels call, with the same arguments,
   from the URL alone — one cache entry each, so the panel finds its data
   already on the way. They render nothing, so nothing above them re-renders. */

export function SoDetailWarmup({ docNo }: { docNo: string | undefined }) {
  const key = docNo ?? null;
  useOrderMoney(key);
  useConvertSources(key);
  useCancelRequest("so", key);
  useSoBackdateRequests(key);
  useRefundSource("SO", docNo ?? "");
  useDocumentFlow("so", key);
  useSoDropdownOptions("payment_method");
  return null;
}

export function DoDetailWarmup({ id }: { id: string | undefined }) {
  useDocumentFlow("do", id ?? null);
  useRacks();
  return null;
}
