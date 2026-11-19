// Mail Center — what to tell the operator about an outbound message that has
// not gone out yet. Shared by desktop (Thread.tsx / Compose.tsx) and the phone
// (MobileMailCenter.tsx) so both say the same thing.
//
// A send whose immediate attempt failed but which the outbox will retry comes
// back { ok: true, queued: true } and is already on the thread. Telling the
// operator "failed" there would make them send it a second time.

export type DeliveryStatus = "queued" | "failed" | "delivered" | "opened" | "bounced" | null;
export type DeliveryTone = "waiting" | "bad" | "good";

export function deliveryLabel(status: DeliveryStatus | undefined): string | null {
  if (status === "queued") return "Queued, retrying";
  if (status === "failed") return "Not delivered";
  if (status === "bounced") return "Bounced: check the address";
  if (status === "delivered") return "Delivered";
  if (status === "opened") return "Opened";
  return null;
}

export function deliveryTone(status: DeliveryStatus | undefined): DeliveryTone {
  if (status === "failed" || status === "bounced") return "bad";
  if (status === "delivered" || status === "opened") return "good";
  return "waiting";
}

export function sentToast(queued: boolean | undefined, sentText: string): string {
  return queued ? "Not sent yet. It is queued and will retry within 5 minutes." : sentText;
}
