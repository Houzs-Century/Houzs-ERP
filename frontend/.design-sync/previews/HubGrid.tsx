import { HubGrid } from "autocount-sync-frontend";
import {
  ShoppingCart,
  Truck,
  Wrench,
  Package,
  Warehouse,
  Users,
  ClipboardList,
  RotateCcw,
} from "lucide-react";

// Section-hub landing grid — Supply Chain / Team / Service Cases use it as
// the jump-off page into sub-sections. Petrol hover lift, optional count
// chip for open work. Purely presentational: cards in, clicks out.

export const SupplyChainHub = () => (
  <div className="w-[44rem]">
    <HubGrid
      cards={[
        {
          key: "so",
          label: "Sales Orders",
          description: "Quotes, confirmations and AutoCount sync status",
          icon: ShoppingCart,
          onClick: () => {},
        },
        {
          key: "do",
          label: "Delivery Orders",
          description: "Trips queue, POD photos and driver assignment",
          icon: Truck,
          count: 8,
          onClick: () => {},
        },
        {
          key: "po",
          label: "Purchase Orders",
          description: "Supplier POs, pricing and goods received",
          icon: Package,
          onClick: () => {},
        },
        {
          key: "stock",
          label: "Stock",
          description: "On-hand by warehouse, transfers and stock takes",
          icon: Warehouse,
          onClick: () => {},
        },
        {
          key: "returns",
          label: "Returns",
          description: "Delivery returns and purchase returns",
          icon: RotateCcw,
          count: 3,
          onClick: () => {},
        },
        {
          key: "reps",
          label: "Sales Reps",
          description: "Agents, uplines and commission mapping",
          icon: Users,
          onClick: () => {},
        },
      ]}
    />
  </div>
);

export const ServiceHub = () => (
  <div className="w-[44rem]">
    <HubGrid
      cards={[
        {
          key: "cases",
          label: "Service Cases",
          description: "ASSR complaints, 9-stage workflow and SLA alerts",
          icon: Wrench,
          count: 12,
          onClick: () => {},
        },
        {
          key: "inspections",
          label: "Inspections",
          description: "Technician site visits awaiting report",
          icon: ClipboardList,
          count: 4,
          onClick: () => {},
        },
        {
          key: "pickups",
          label: "Item Pickups",
          description: "Defective units queued for collection",
          icon: Truck,
          onClick: () => {},
        },
      ]}
    />
  </div>
);
