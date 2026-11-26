
export type DeliveryStatus = "queued" | "failed" | "delivered" | "bounced" | null;
export type DeliveryTone = "waiting" | "bad" | "good";

export function deliveryLabel(status: DeliveryStatus | undefined): string | null {
  if (status === "queued") return "Queued, retrying";
  if (status === "failed") return "Not delivered";
  if (status === "bounced") return "Bounced: check the address";
  if (status === "delivered") return "Delivered";
  return null;
}

export function deliveryTone(status: DeliveryStatus | undefined): DeliveryTone {
  if (status === "failed" || status === "bounced") return "bad";
  if (status === "delivered") return "good";
  return "waiting";
}

export function sentToast(queued: boolean | undefined, sentText: string): string {
  return queued ? "Not sent yet. It is queued and will retry within 5 minutes." : sentText;
}
