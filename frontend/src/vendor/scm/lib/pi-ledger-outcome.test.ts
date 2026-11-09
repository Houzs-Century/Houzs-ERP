import { describe, expect, it } from 'vitest';
import { piCreatedAndPostedSentence, piLedgerGap } from './pi-ledger-outcome';

describe('what the New-PI dialog says after create + post', () => {
  it('claims the AP liability only when the server says a journal was written', () => {
    expect(piCreatedAndPostedSentence({ posted: true, status: 'posted', jeNo: 'JE-2611-004' }))
      .toBe('Created + posted — AP liability recorded (JE-2611-004).');
  });

  it('a refused journal is named, with the server reason, and never called recorded', () => {
    const s = piCreatedAndPostedSentence({ posted: false, status: 'group_unbound', reason: 'Group SOFA has no purchase account' });
    expect(s).toContain('NOT in the ledger');
    expect(s).toContain('Group SOFA has no purchase account.');
    expect(s).not.toContain('recorded');
  });

  it('a refusal with no reason still says why in words', () => {
    expect(piCreatedAndPostedSentence({ posted: false, status: 'zero_total', reason: null }))
      .toContain('the invoice total is zero.');
  });

  it('migrated paperwork is not a failure and is not called recorded here', () => {
    const s = piCreatedAndPostedSentence({ posted: false, status: 'migrated_source', reason: null });
    expect(s).toContain('AutoCount already booked');
    expect(piLedgerGap({ posted: false, status: 'migrated_source', reason: null })).toBeNull();
  });

  it('no ledger answer makes no claim either way', () => {
    expect(piCreatedAndPostedSentence(undefined)).not.toContain('recorded');
    expect(piLedgerGap(undefined)).toBeNull();
  });

  it('an unknown failure status still reports a gap', () => {
    expect(piLedgerGap({ posted: false, status: 'je_insert_failed', reason: null })).toContain('(je_insert_failed)');
  });
});
