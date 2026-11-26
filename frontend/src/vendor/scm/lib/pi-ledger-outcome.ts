export type PiLedgerOutcome =
  | { posted: true; status: 'posted' | 'already_posted'; jeNo: string }
  | { posted: false; status: string; reason: string | null };

const NOT_POSTED_WHY: Record<string, string> = {
  zero_total: 'the invoice total is zero.',
  group_unbound: 'a product group on it has no purchase account set.',
  line_ungrouped: 'a line on it has no product group.',
  no_lines: 'it has no lines.',
  invoice_not_found: 'the invoice could not be read back.',
};

export function piLedgerGap(ledger: PiLedgerOutcome | undefined): string | null {
  if (!ledger || ledger.posted || ledger.status === 'migrated_source') return null;
  const raw = ledger.reason?.trim() || NOT_POSTED_WHY[ledger.status] || `the journal could not be written (${ledger.status}).`;
  const why = /[.!?]$/.test(raw) ? raw : `${raw}.`;
  return `the AP liability is NOT in the ledger yet: ${why} Tell finance — this invoice still needs its AP journal once that is fixed.`;
}

export function piCreatedAndPostedSentence(ledger: PiLedgerOutcome | undefined): string {
  if (!ledger) return 'Created + posted. Open it to check its AP journal entry.';
  if (ledger.posted) return `Created + posted — AP liability recorded (${ledger.jeNo}).`;
  if (ledger.status === 'migrated_source') return 'Created + posted — no journal written here: AutoCount already booked this payable.';
  return `Created, but ${piLedgerGap(ledger)}`;
}
