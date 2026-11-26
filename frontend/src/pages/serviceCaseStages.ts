import type { AssrStage } from "../types";

export const NEXT_STAGE: Record<string, { stage: AssrStage; label: string }> = {
  pending_review:           { stage: "pending_solution",         label: "Move to Solution" },
  pending_solution:         { stage: "under_verification",       label: "Start Verification" },
  under_verification:       { stage: "pending_supplier_pickup",  label: "Hand to Supplier" },
  pending_supplier_pickup:  { stage: "pending_item_ready",       label: "Mark Item Ready" },
  pending_item_ready:       { stage: "pending_delivery_service", label: "Arrange Delivery" },
  pending_delivery_service: { stage: "completed",                label: "Close Case" },
};

export const STAGE_FUNNEL_DESC: Record<string, string> = {
  pending_review: "New case — first review",
  under_verification: "Inspect & verify the issue",
  pending_solution: "Decide fix & assign supplier",
  pending_supplier_pickup: "Customer pickup · supplier pickup · supplier return",
  pending_item_ready: "Repair done — QC check",
  pending_delivery_service: "Schedule return delivery",
  completed: "Closed & rated",
};
