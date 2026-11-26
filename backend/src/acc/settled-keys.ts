// ----------------------------------------------------------------------------
// settled-keys — the card payments already taken: by a merchant report line
// (scm.acc_settlement_matches) or by a bank movement that took the money in
// directly (acc/bank-card-settled, owner 2026-11-17). Either way the payment is
// nobody's candidate again — not a report line's, not Find the sale's, not on
// the watch list of card payments no report has carried.
//
// Lifted out of acc/settlement (which re-exports both) so the second source
// could be added without that file passing its size cap.
// ----------------------------------------------------------------------------

import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import { loadBankCardKeys } from './bank-card-settled';
import type { resolveRoles } from './rules';

type Sb = Parameters<typeof resolveRoles>[0];

export async function loadSettledKeys(
  sb: Sb,
  companyId: number,
): Promise<{ ok: true; keys: Set<string> } | { ok: false; reason: string }> {
  const [linked, banked] = await Promise.all([
    paginateAll<{ payment_source: string; payment_id: string }>((f, t) => sb
      .from('acc_settlement_matches').select('payment_source, payment_id')
      .eq('company_id', companyId).order('id').range(f, t)),
    loadBankCardKeys(sb, companyId, null),
  ]);
  if (linked.error) return { ok: false, reason: linked.error.message };
  if (!banked.ok) return banked;
  const keys = new Set<string>(banked.keys);
  for (const r of linked.data ?? []) {
    keys.add(`${r.payment_source}:${r.payment_id}`);
  }
  return { ok: true, keys };
}

/** loadSettledKeys asked only about the payments a caller holds. Its readers
    (matchStatement, recordedNotArrived) only ask about payments in their own
    list, so other payments' claims never change a result — and reading them
    paged the whole link table on every open. Per source, for the unique index. */
export async function loadSettledKeysFor(
  sb: Sb,
  companyId: number,
  payments: ReadonlyArray<{ source: string; id: string }>,
): Promise<{ ok: true; keys: Set<string> } | { ok: false; reason: string }> {
  const idsBySource = new Map<string, Set<string>>();
  for (const p of payments) {
    const ids = idsBySource.get(p.source) ?? new Set<string>();
    ids.add(String(p.id));
    idsBySource.set(p.source, ids);
  }
  const [reads, banked] = await Promise.all([
    Promise.all([...idsBySource].map(([source, ids]) => chunkIn<{ payment_source: string; payment_id: string }>(
      [...ids], (batch, f, t) => sb
        .from('acc_settlement_matches').select('payment_source, payment_id')
        .eq('company_id', companyId).eq('payment_source', source).in('payment_id', batch)
        .order('id').range(f, t),
    ))),
    loadBankCardKeys(sb, companyId, payments),
  ]);
  if (!banked.ok) return banked;
  const keys = new Set<string>(banked.keys);
  for (const r of reads) {
    if (r.error) return { ok: false, reason: r.error.message };
    for (const m of r.data) keys.add(`${m.payment_source}:${m.payment_id}`);
  }
  return { ok: true, keys };
}
