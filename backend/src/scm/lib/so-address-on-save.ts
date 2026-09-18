// ----------------------------------------------------------------------------
// so-address-on-save — the sales-order address is fitted to the account book's
// column widths when it is SAVED, not only when it is sent.
//
// Owner, 2026-09-09: 「把我们的 address lock成 40 个字」. AutoCount's four
// address columns are 40 characters and it refuses the WHOLE document when one
// is over, so an over-long line kept a sales order out of the accounts entirely
// (docs/bugs/0728). Fitting it at the SEND was the patch; fitting it at the SAVE
// is what makes the ERP hold what the book holds, so the two never disagree
// about where a customer lives (docs/bugs/0738).
//
// Its own module because mfg-sales-orders.ts is at its size ceiling and a
// ceiling only moves down (docs/repo-hygiene.md) — and because this is one idea
// the route neither needs to explain nor to repeat.
// ----------------------------------------------------------------------------
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { scopeToCompany } from './companyScope';
import { fitSoAddress } from '../../services/autocount-address-fit';

type Sb = { from: (t: string) => any };

/** The four columns, as one unit. They are fitted together or not at all. */
const ADDRESS_COLS = ['address1', 'address2', 'address3', 'address4'] as const;

/**
 * Fit a pending UPDATE's address, IN PLACE, when the change touches one.
 *
 * TOGETHER, and that is why this cannot sit in the route's field-map loop: a
 * line cannot be fitted on its own, because an over-long first line spills into
 * the second. A PATCH carrying only `address1` therefore needs the other three
 * AS STORED — merged, fitted, and all four written back — or the spill would
 * overwrite a line the caller never mentioned with nothing.
 *
 * A READ FAILURE LEAVES THE ADDRESS ALONE. Without the stored lines the merge
 * would blank what it cannot see. The value is still fitted on the way out by
 * `soInvoiceAddress`, so nothing over-long reaches the account book — the cost
 * of this branch is a stored line wider than 40, not a refused document. Not
 * writing beats writing something wrong.
 *
 * An address that already fits is stored exactly as typed, so a save that had
 * nothing to do with the address never re-flows one.
 */
export async function fitAddressIfTouched(
  sb: Sb,
  c: Context<{ Bindings: Env; Variables: Variables }>,
  docNo: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (!ADDRESS_COLS.some((col) => col in updates)) return;
  const { data: held, error: heldErr } = await scopeToCompany(
    sb.from('mfg_sales_orders').select('address1, address2, address3, address4').eq('doc_no', docNo), c,
  ).maybeSingle();
  if (heldErr) return;
  const stored = (held ?? {}) as Record<string, string | null>;
  const merged = ADDRESS_COLS.map((col) => (
    col in updates ? ((updates[col] as string | null) ?? null) : (stored[col] ?? null)
  ));
  Object.assign(updates, fitSoAddress(merged));
}
