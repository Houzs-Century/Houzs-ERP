/* Copy as new (HC-0149): a PWP reward line is only valid with its single-use code
   (variants.pwp + variants.pwpCode). While the source order is live the code is USED
   on it, so copying the line makes the server refuse the save (409 pwp_code_rejected).
   A line without a code would be repriced to full price, so the reward line is left
   out and the operator re-adds it with a new code. A CANCELLED source (convert flow)
   has released its codes, so its lines are copied untouched. */
export const isPwpRewardLine = (it: { variants?: unknown }): boolean => {
  const v = (it.variants ?? {}) as { pwp?: unknown; pwpCode?: unknown };
  return Boolean(v.pwp) || String(v.pwpCode ?? '').trim() !== '';
};

export function copyLinesWithoutPwp<T extends { variants?: unknown }>(
  items: T[], sourceStatus?: string | null,
): { kept: T[]; dropped: number } {
  if (sourceStatus === 'CANCELLED') return { kept: items, dropped: 0 };
  const kept = items.filter((it) => !isPwpRewardLine(it));
  return { kept, dropped: items.length - kept.length };
}

export const pwpDroppedNotice = (n: number): string =>
  `${n} PWP line(s) left out - re-add with a new code`;

/* Call-site entry for the SO desktop and mobile copy seeds: live (non-cancelled) lines, PWP rewards
   left out, and the operator told when any were. */
export function copySeedLines<T extends { variants?: unknown; cancelled?: unknown }>(
  items: T[] | null | undefined, sourceStatus: string | null | undefined,
  notify: (n: { title: string; body: string }) => unknown,
): T[] {
  const { kept, dropped } = copyLinesWithoutPwp((items ?? []).filter((it) => !it.cancelled), sourceStatus);
  if (dropped > 0) notify({ title: 'PWP line left out', body: pwpDroppedNotice(dropped) });
  return kept;
}

/* The source order's columns a copy reads (the detail payload's snake_case). */
export type SoCopySource = {
  debtor_code?: string | null; debtor_name?: string | null; phone?: string | null; email?: string | null;
  salesperson_id?: string | number | null; customer_type?: string | null; building_type?: string | null; note?: string | null;
  address1?: string | null; address2?: string | null; address3?: string | null; address4?: string | null;
  customer_state?: string | null; city?: string | null; postcode?: string | null;
  emergency_contact_name?: string | null; emergency_contact_relationship?: string | null; emergency_contact_phone?: string | null;
};

/* The header a copy seeds, ONE rule for the desktop and phone forms (HC-0149): customer,
   address, emergency contact, note. Never dates, payments, refs, doc no or status — the
   copy is a clean draft. City / postcode fall back to address3 / address4 the way older
   orders stored them. */
export function soCopyHeaderSeed(h: SoCopySource) {
  return {
    debtorCode: h.debtor_code ?? '', debtorName: h.debtor_name ?? '', phone: h.phone ?? '', email: h.email ?? '',
    salespersonId: h.salesperson_id != null ? String(h.salesperson_id) : '',
    customerType: h.customer_type ?? '', buildingType: h.building_type ?? '', note: h.note ?? '',
    address1: h.address1 ?? '', address2: h.address2 ?? '', address3: h.address3 ?? '', address4: h.address4 ?? '',
    state: h.customer_state ?? '', city: h.city ?? h.address3 ?? '', postcode: h.postcode ?? h.address4 ?? '',
    emergencyName: h.emergency_contact_name ?? '', emergencyRel: h.emergency_contact_relationship ?? '', emergencyPhone: h.emergency_contact_phone ?? '',
  };
}
export type SoCopyHeaderSeed = ReturnType<typeof soCopyHeaderSeed>;
