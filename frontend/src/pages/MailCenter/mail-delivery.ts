// Mail Center — what to tell the operator about an outbound message that has
// not gone out yet. Shared by desktop (Thread.tsx / Compose.tsx) and the phone
// (MobileMailCenter.tsx) so both say the same thing.
//
// A send whose immediate attempt failed but which the outbox will retry comes
// back { ok: true, queued: true } and is already on the thread. Telling the
// operator "failed" there would make them send it a second time.

export type DeliveryStatus = "queued" | "failed" | null;

export function deliveryLabel(status: DeliveryStatus | undefined): string | null {
  if (status === "queued") return "Queued, retrying";
  if (status === "failed") return "Not delivered";
  return null;
}

export function sentToast(queued: boolean | undefined, sentText: string): string {
  return queued ? "Not sent yet. It is queued and will retry within 5 minutes." : sentText;
}
