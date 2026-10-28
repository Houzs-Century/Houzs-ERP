// ----------------------------------------------------------------------------
// order-address — a Sales Order's customer address as its printed documents
// show it. One home for the rule the SO print grew (owner 2026-06-12, "crossed
// address"), so the Deposit Invoice printed off the same order (owner
// 2026-10-06) reads the same lines.
//
// The ship-to block wins when one was typed; otherwise Address line 1 and 2,
// then ONE locality line "postcode city state" where city = city ?? address3
// and postcode = postcode ?? address4 (the PR #39 POS column mapping — the
// page never renders address3/address4 as raw lines). POS-composed rows
// already carry the postcode/city/state INSIDE the address lines, so each
// locality part is appended ONLY when it does not appear above, the parts are
// deduped against each other (city == state on KL), and exact-duplicate lines
// drop.
// ----------------------------------------------------------------------------

export type OrderAddressFields = {
  ship_to_address?: string | null;
  address1?: string | null;
  address2?: string | null;
  address3?: string | null;
  address4?: string | null;
  postcode?: string | null;
  city?: string | null;
  customer_state?: string | null;
};

export function orderAddressLines(h: OrderAddressFields): string[] {
  const baseAddressLines = (h.ship_to_address ?? '').trim()
    ? (h.ship_to_address as string).split('\n').map((s) => s.trim()).filter(Boolean)
    : [h.address1, h.address2]
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean);
  const addressHaystack = baseAddressLines.join(' ').toLowerCase();
  const localityParts: string[] = [];
  for (const part of [
    (h.postcode ?? h.address4 ?? '').trim(),
    (h.city ?? h.address3 ?? '').trim(),
    (h.customer_state ?? '').trim(),
  ]) {
    if (!part) continue;
    if (addressHaystack.includes(part.toLowerCase())) continue;   // already inside an address line
    if (localityParts.some((p) => p.toLowerCase() === part.toLowerCase())) continue; // e.g. city == state (KL)
    localityParts.push(part);
  }
  const seenAddressLines = new Set<string>();
  return [...baseAddressLines, localityParts.join(' ')].filter((l) => {
    if (!l) return false;
    const k = l.toLowerCase();
    if (seenAddressLines.has(k)) return false;
    seenAddressLines.add(k);
    return true;
  });
}
