// ----------------------------------------------------------------------------
// One ringgit, one product group, one account — the split a document's lines
// make before they reach the ledger (GL redesign item 2, owner 2026-09-05:
// ledger 只根据 invoice 认; docs/bugs/0829 for the sales side).
//
// The purchase invoice has posted this way since 2026-09-05: one debit per
// PRODUCT GROUP to that group's own purchase account. The sales invoice now
// posts the mirror: one credit per group to that group's own sales account —
// 2990's chart keeps SALES OF SOFA / BEDDING / DINING / … as separate leaves
// and its 500-0000 (RENTAL REVENUE) is INACTIVE, so a sale could not be
// booked at all on the old two-line rule.
//
// One home for the rule both sides share: the registry stores upper-case
// group codes and the sales panels write lower-case (one case-fold, never
// two vocabularies); a line with no group REFUSES by name and so does a
// group with no binding — the owner's own rule (挡下来提醒我去绑), because a
// figure silently landed on the wrong account is exactly the
// mis-classification the registry exists to end; and the header total is
// the LAW: per-group rounding must sum to exactly what the document posts,
// so any remainder lands on the largest group.
// ----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST client, untyped throughout the acc layer */
type Db = any;

export type GroupSplitLine = { item_group: string | null; line_total_sen: number | null };
export type GroupAmount = { groupCode: string; accountCode: string; myrSen: number };
export type GroupSplitResult =
  | { ok: true; groups: GroupAmount[] }
  | { ok: false; status: 'no_lines' | 'line_ungrouped' | 'group_unbound' | 'post_failed'; reason: string };

export async function splitByItemGroup(
  sb: Db,
  p: {
    companyId: number | null;
    /** The document's number, for the refusal sentences. */
    docNo: string;
    items: GroupSplitLine[];
    /** Which binding of scm.acc_item_group_accounts to read. */
    account: 'purchase_account' | 'sales_account';
    /** The document's own currency → MYR sen, once per group (identity for MYR). */
    myrSen: (sen: number) => number;
    /** The header total in MYR sen — the figure the groups must sum to. */
    totalSen: number;
  },
): Promise<GroupSplitResult> {
  const noun = p.account === 'purchase_account' ? 'purchase' : 'sale';
  if (p.items.length === 0) {
    return { ok: false, status: 'no_lines', reason: `${p.docNo} has no lines — a ${noun} cannot be classified without them.` };
  }
  const foreignByGroup = new Map<string, number>();
  for (const it of p.items) {
    const g = String(it.item_group ?? '').trim().toUpperCase();
    if (!g) {
      return { ok: false, status: 'line_ungrouped', reason: `${p.docNo} has a line with no product group — fix the line, then post.` };
    }
    foreignByGroup.set(g, (foreignByGroup.get(g) ?? 0) + Number(it.line_total_sen ?? 0));
  }
  const groupCodes = [...foreignByGroup.keys()];
  const { data: bindsRaw, error: bindsErr } = await sb
    .from('acc_item_group_accounts')
    .select(`group_code, ${p.account}`)
    .eq('company_id', p.companyId)
    .in('group_code', groupCodes);
  if (bindsErr) return { ok: false, status: 'post_failed', reason: `group bindings: ${bindsErr.message}` };
  const accountOf = new Map<string, string>();
  for (const b of (bindsRaw ?? []) as Array<Record<string, unknown>>) {
    const code = String(b[p.account] ?? '').trim();
    if (code) accountOf.set(String(b.group_code), code);
  }
  const unbound = groupCodes.filter((g) => !accountOf.get(g));
  if (unbound.length > 0) {
    return {
      ok: false,
      status: 'group_unbound',
      reason: `${unbound.join(', ')} ${unbound.length === 1 ? 'is' : 'are'} not bound to a ${p.account === 'purchase_account' ? 'purchase' : 'sales'} account for this company — bind ${unbound.length === 1 ? 'it' : 'them'} on Accounting → Item Groups, then post again.`,
    };
  }
  const groups: GroupAmount[] = groupCodes.map((g) => ({
    groupCode: g,
    accountCode: accountOf.get(g) as string,
    myrSen: p.myrSen(foreignByGroup.get(g) ?? 0),
  }));
  const drift = p.totalSen - groups.reduce((s, g) => s + g.myrSen, 0);
  if (drift !== 0) {
    const biggest = groups.reduce((a, b) => (b.myrSen > a.myrSen ? b : a));
    biggest.myrSen += drift;
  }
  return { ok: true, groups };
}
