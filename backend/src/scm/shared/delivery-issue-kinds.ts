/* The problem kinds a delivery crew can report at POD ("Delivered with issue").
   backend/src/scm/shared/delivery-issue-kinds.ts and
   frontend/src/vendor/scm/lib/delivery-issue-kinds.ts are byte-identical
   (delivery-issue-kinds.canonical.test.ts); change both together. */

export const DELIVERY_ISSUE_KINDS = [
  { value: "damaged", label: "Damaged" },
  { value: "missing_part", label: "Missing part" },
  { value: "wrong_item", label: "Wrong item or colour" },
  { value: "customer_refused", label: "Customer refused part" },
  { value: "other", label: "Other" },
] as const;

export type DeliveryIssueKind = (typeof DELIVERY_ISSUE_KINDS)[number]["value"];

export const DELIVERY_ISSUE_NOTE_MAX = 1000;
export const DELIVERY_ISSUE_MAX_PHOTOS = 10;

export function deliveryIssueKindLabel(kind: string): string {
  return DELIVERY_ISSUE_KINDS.find((k) => k.value === kind)?.label ?? kind;
}
