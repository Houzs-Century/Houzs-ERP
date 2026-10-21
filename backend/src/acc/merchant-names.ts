// ----------------------------------------------------------------------------
// acc/merchant-names — which merchant a payment was keyed under.
//
// The till stores the merchant as free text from a dropdown (Pinelabs, Public,
// MBB …); Merchant Recon knows each merchant by its display name. They are not
// always the same word for the same money: AEON's report comes off the Pine
// Labs terminal, and the dropdown calls Public Bank "Public". Owner 2026-10-21:
// 「Pinelabs=AEON，Public=PBB」. Each merchant therefore carries its OTHER
// names (scm.acc_acquirer_config.so_names, Setup › "Also keyed on Sales Orders
// as"), and every reader that asks "is this payment that merchant's?" asks it
// here — Merchant Recon's pools, the watch list, the confirm's tag stamp, the
// card payment's clearing account, the Unmatched Payments check.
//
// Pure: no reads, no writes.
// ----------------------------------------------------------------------------

/** A merchant name as the till typed it, compared without case or edge spaces. */
const nameKey = (s: string | null | undefined): string => String(s ?? '').trim().toUpperCase();

/** Every name a merchant's money is keyed under: its display name first, then
    its other names. Blank and repeated names are dropped. */
export function merchantNamesOf(a: { display_name: string; so_names?: readonly string[] | null }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of [a.display_name, ...(a.so_names ?? [])]) {
    const t = String(n ?? '').trim();
    if (t === '' || seen.has(nameKey(t))) continue;
    seen.add(nameKey(t));
    out.push(t);
  }
  return out;
}

/** Whether a payment keyed as `provider` is keyed under one of these names. */
export function keyedAs(provider: string | null | undefined, names: readonly string[]): boolean {
  const k = nameKey(provider);
  return k !== '' && names.some((n) => nameKey(n) === k);
}

/** The merchant, of several, a payment keyed as `provider` belongs to — or
    null when none of them answers to that name. */
export function merchantKeyedAs<T extends { display_name: string; so_names?: readonly string[] | null }>(
  provider: string | null | undefined, merchants: readonly T[],
): T | null {
  return merchants.find((m) => keyedAs(provider, merchantNamesOf(m))) ?? null;
}
