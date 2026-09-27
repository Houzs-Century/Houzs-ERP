// ----------------------------------------------------------------------------
// vp-brand-prompt -- "which brand is this bill for?" (owner 2026-09-27).
//
// A bed frame or an accessory is never sold on its own: it is a second bill
// written at a brand's fair, and the Venture Portal's commission follows that
// fair's brand. The products on such a bill name no brand, so after a save that
// makes it a live order -- a create, a draft confirmed -- the server says so on
// its response (`vpBrand`: the choices, and the linked booth's brand to suggest)
// and this asks. Optional: Skip leaves the bill unanswered. The answer is stored
// for the portal only (PUT /mfg-sales-orders/:docNo/vp-brand); the order's own
// branding is never touched.
//
// A module-level bridge, like dialog-service.ts, because the save that learns
// the answer is needed lives in the query layer (sales-order-queries.ts), which
// is outside the React tree. <VpBrandPromptBridge> registers the live pick-one
// dialog in BOTH shells (desktop Scm2990Shell, mobile MobileApp), so desktop and
// mobile ask the same question from the same place. Before a shell mounts
// nothing is asked -- the question is optional, and a browser prompt() would be
// worse than none.
// ----------------------------------------------------------------------------

import type { ChoiceOpts } from '../components/ChoiceDialog';
import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';

/** What a save answers when it wants the question asked (lib/vp-brand.ts on the server). */
export type VpBrandAsk = { suggested: string | null; options: string[] };

type ChooseFn = (opts: ChoiceOpts) => Promise<string | null>;

let liveChoose: ChooseFn | null = null;

/** Called by <VpBrandPromptBridge> (inside a ChoiceProvider) at mount, and with null at unmount. */
export function registerVpBrandPrompt(choose: ChooseFn | null): void {
  liveChoose = choose;
}

/** The dialog: the suggested brand first, the rest in the company's list order. */
export function vpBrandChoice(docNo: string, ask: VpBrandAsk): ChoiceOpts {
  const suggested = ask.suggested != null && ask.options.includes(ask.suggested) ? ask.suggested : null;
  const ordered = suggested ? [suggested, ...ask.options.filter((o) => o !== suggested)] : ask.options;
  return {
    title: `Which brand is ${docNo} for?`,
    body:
      'Nothing on this bill names a brand. Pick the brand of the fair it was sold at, '
      + 'for the Venture Portal commission. The order itself does not change.',
    options: ordered.map((o) => (o === suggested
      ? { value: o, label: o, detail: 'The brand of the fair this bill is linked to' }
      : { value: o, label: o })),
    cancelLabel: 'Skip',
  };
}

/**
 * Ask, and store the answer. `ask` is REQUIRED (null when the save did not ask)
 * because it decides whether anything happens at all. A failed save says so and
 * asks again; Skip ends it.
 */
export async function askVpBrand(docNo: string, ask: VpBrandAsk | null): Promise<void> {
  if (ask == null || ask.options.length === 0) return;
  const choose = liveChoose;
  if (choose == null) return;
  const brand = await choose(vpBrandChoice(docNo, ask));
  if (brand == null) return;
  try {
    await authedFetch(`/mfg-sales-orders/${encodeURIComponent(docNo)}/vp-brand`, {
      method: 'PUT',
      body: JSON.stringify({ brand }),
    });
  } catch (e) {
    await serviceNotify({
      title: 'Brand not saved',
      body: `${docNo} is saved, but its brand for the Venture Portal is not: ${
        e instanceof Error ? e.message : 'something went wrong'}. Pick it again, or Skip.`,
      tone: 'error',
    });
    await askVpBrand(docNo, { ...ask, suggested: brand });
  }
}
