import { DocumentLinesExpansion } from "autocount-sync-frontend";

// Shared inline per-line breakdown rendered under a document row when the
// DataTable chevron is toggled (DRY twin of the SO list's SoLinesExpansion).
// Purely presentational: callers map their detail-hook items into
// DocumentDrillLine[] — Group pill + item identity + Qty + Amount, plus the
// Assigned SO / SO Delivery Date columns on purchase docs (showAssignment).

const SALES_LINES = [
  {
    itemGroup: "SOFA",
    code: "SF-LUNA-3S",
    description: "Luna 3-Seater Sofa — feather-wrapped seat",
    description2: null,
    variants: { Fabric: "Linen Sand", Legs: "Walnut" },
    qty: 2,
    amountSen: 918000,
  },
  {
    itemGroup: "BEDFRAME",
    code: "BF-ARIA-Q",
    description: "Aria Queen Bedframe — oak headboard",
    description2: "Queen · Oak · floor-clearance legs",
    variants: { Size: "Queen", Finish: "Oak" },
    qty: 1,
    amountSen: 629000,
  },
  {
    itemGroup: "MATTRESS",
    code: "MT-CLOUD-Q",
    description: "Cloud Firm Queen Mattress",
    description2: null,
    variants: null,
    qty: 3,
    amountSen: 387000,
  },
];

const PURCHASE_LINES = [
  {
    itemGroup: "SOFA",
    code: "SF-LUNA-3S",
    description: "Luna 3-Seater Sofa — factory order",
    description2: null,
    variants: { Fabric: "Linen Sand", Legs: "Walnut" },
    qty: 4,
    amountSen: 1436000,
    assignedSos: [
      { soDocNo: "SO-2990-0417", deliveryDate: "2026-08-02" },
      { soDocNo: "SO-2990-0433", deliveryDate: null },
    ],
  },
  {
    itemGroup: "MATTRESS",
    code: "MT-CLOUD-K",
    description: "Cloud Firm King Mattress — factory order",
    description2: null,
    variants: { Size: "King" },
    qty: 2,
    amountSen: 1258000,
    assignedSos: [],
  },
];

export const SalesDocLines = () => (
  <div className="w-[640px]">
    <DocumentLinesExpansion isLoading={false} lines={SALES_LINES} />
  </div>
);

export const PurchaseWithOriginSo = () => (
  <div className="w-[920px]">
    <DocumentLinesExpansion
      isLoading={false}
      lines={PURCHASE_LINES}
      showAssignment
      onOpenSo={() => {}}
    />
  </div>
);

export const LoadingState = () => (
  <div className="w-[640px]">
    <DocumentLinesExpansion isLoading lines={[]} />
  </div>
);

export const EmptyDoc = () => (
  <div className="w-[640px]">
    <DocumentLinesExpansion isLoading={false} lines={[]} emptyLabel="No lines on this document." />
  </div>
);
