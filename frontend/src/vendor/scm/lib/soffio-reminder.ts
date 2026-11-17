import type { ConfirmOpts } from '../components/ConfirmDialog';
import { authedFetch } from './authed-fetch';

/* Salespeople pick the SOFFIO code (8030-) for a fully extend sofa, which is
   SOFFIO 2.0 (5562-). Every path that turns a sales order CONFIRMED asks once
   before it goes through (owner 2026-11-17). Desktop and mobile share this. */
export const SOFFIO_PREFIX = '8030-';

export type SoffioReminder = { codes: string[]; dialog: ConfirmOpts };

export function soffioReminder(itemCodes: ReadonlyArray<string | null | undefined>): SoffioReminder | null {
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const raw of itemCodes) {
    const code = (raw ?? '').trim();
    if (!code.toUpperCase().startsWith(SOFFIO_PREFIX)) continue;
    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push(code);
  }
  if (codes.length === 0) return null;
  return {
    codes,
    dialog: {
      title: 'Check the SOFFIO code',
      body: `This order has SOFFIO (8030) items: ${codes.join(', ')}. Make sure it is SOFFIO. `
        + 'If the sofa is fully extend, it is SOFFIO 2.0 (5562 codes): do not pick the wrong code.',
      confirmLabel: 'Yes, it is SOFFIO',
      cancelLabel: 'Go back',
    },
  };
}

/** True when the confirm may go ahead: no 8030 line, or the operator said yes. */
export async function passesSoffioReminder(
  ask: (opts: ConfirmOpts) => Promise<boolean>,
  itemCodes: ReadonlyArray<string | null | undefined>,
): Promise<boolean> {
  const reminder = soffioReminder(itemCodes);
  if (!reminder) return true;
  return ask(reminder.dialog);
}

type SoLinesDetail = { items?: Array<{ item_code?: string | null; cancelled?: boolean | null }> };

/** The live (non-cancelled) item codes of one order, for confirm paths whose row has no lines. */
export async function fetchSoItemCodes(
  docNo: string,
  fetcher: <T>(path: string) => Promise<T> = authedFetch,
): Promise<string[]> {
  const detail = await fetcher<SoLinesDetail>(`/mfg-sales-orders/${encodeURIComponent(docNo)}`);
  return (detail.items ?? []).filter((it) => !it.cancelled).map((it) => it.item_code ?? '');
}
