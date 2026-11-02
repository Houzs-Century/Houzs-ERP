// ----------------------------------------------------------------------------
// moneyInDocQueries — what a Money-in document's page reads beyond the
// document itself (the owner's Claude Design, batch 5 §8.3): the journals it
// booked, for the Books line and the trail. Read from the ledger, never
// assumed — the Books line names the accounts the entry actually hit.
// ----------------------------------------------------------------------------

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { fmtSen } from '../../../vendor/shared/format';

export type DocJournalLine = {
  line_no: number; account_code: string; debit_sen: number; credit_sen: number; party_name: string | null; notes: string | null;
};
export type DocJournal = {
  id: string; je_no: string; entry_date: string; source_type: string; reversed: boolean; created_at: string;
  lines?: DocJournalLine[];
};
export type DocJournals = { booked: DocJournal[]; contras: DocJournal[] };

/** The entries a document booked under its source type (an edit re-posts, so
 *  there may be several) and the contras that reversed them (`<type>_REVERSAL`,
 *  the same document number). Keyed under 'journal-entries' so every write that
 *  refreshes the journal refreshes this too. */
export const useDocJournals = (sourceType: string, docNo: string | null | undefined) => useQuery({
  queryKey: ['journal-entries', 'document', sourceType, docNo ?? null],
  enabled: Boolean(docNo),
  queryFn: async (): Promise<DocJournals> => {
    const read = (type: string) => authedFetch<{ journalEntries: DocJournal[] }>(
      `/accounting/journal-entries?sourceType=${encodeURIComponent(type)}&sourceDocNo=${encodeURIComponent(String(docNo))}&withLines=1`,
    );
    const [booked, contras] = await Promise.all([read(sourceType), read(`${sourceType}_REVERSAL`)]);
    return { booked: booked.journalEntries, contras: contras.journalEntries };
  },
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

/** The entry that stands: the newest one not reversed. */
export const liveJournal = (j: DocJournals | undefined): DocJournal | null =>
  j?.booked.filter((e) => !e.reversed).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;

type Named = (code: string) => string | null;
const side = (lines: DocJournalLine[], dr: boolean, named: Named): string => {
  const seen = new Map<string, string>();
  for (const l of lines) {
    if ((dr ? l.debit_sen : l.credit_sen) <= 0 || seen.has(l.account_code)) continue;
    const name = named(l.account_code);
    seen.set(l.account_code, `${l.account_code}${name ? ` ${name}` : ''}${l.party_name ? ` (${l.party_name})` : ''}`);
  }
  return [...seen.values()].join(', ') || '—';
};

/** The Books line of a posted document: `Dr … · Cr … · RM x`, from its journal. */
export function booksSentence(je: DocJournal, named: Named): string {
  const lines = je.lines ?? [];
  const total = lines.reduce((s, l) => s + Number(l.debit_sen), 0);
  return `Dr ${side(lines, true, named)} · Cr ${side(lines, false, named)} · ${fmtSen(total)}`;
}
