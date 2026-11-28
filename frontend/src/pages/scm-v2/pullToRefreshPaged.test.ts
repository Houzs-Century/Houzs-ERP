import { describe, expect, test } from "vitest";
import po from "./PurchaseOrdersListV2.tsx?raw";
import dO from "./MfgDeliveryOrdersListV2.tsx?raw";
import pi from "./PurchaseInvoicesListV2.tsx?raw";
import si from "./SalesInvoicesListV2.tsx?raw";
import grn from "./GoodsReceivedListV2.tsx?raw";

const pull = (src: string) => src.slice(src.indexOf("const onPullToRefresh = async"), src.indexOf("};", src.indexOf("const onPullToRefresh = async")));

describe("pull-to-refresh refreshes the paged list on screen", () => {
  test.each([
    ["PO", po, "mfg-purchase-orders"],
    ["DO", dO, "mfg-delivery-orders"],
    ["PI", pi, "purchase-invoices"],
    ["SI", si, "sales-invoices"],
    ["GRN", grn, "grns"],
  ])("%s", (_n, src, root) => {
    expect(pull(src)).toContain(`queryKey: ["${root}-paged"]`);
  });
});
