// The four bank recognition rules SHIPPED IN MIGRATION 0305, run against the
// real statement strings they were written from.
//
// Why this lives in tests/ as .mjs and not beside bank-match.test.ts: it reads
// the migration off disk, and src/ is compiled for Workers — no node:fs, no
// import.meta.url. The same reason releaseDiscipline.test.mjs is here.
//
// Why it exists at all: a recognition rule that stops matching FAILS SILENTLY.
// The money simply reads as "not a card payout" for ever, which is precisely
// the 系统3 disease the brief names — 四个收单行只有两条规则，两家的钱永远收不到.
// Nothing else in the suite would notice, because every other test supplies its
// own rules. This one reads what actually ships.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { recogniseAcquirer } from '../src/acc/bank-match';

const sql = readFileSync(
  new URL('../src/db/migrations-pg/0336_acc_bank_reconciliation.sql', import.meta.url),
  'utf8',
);

/* Pull the seeded VALUES rows out of the migration:
     ('CODE', 'pattern', 'field', <date|NULL>, <merchant|NULL>, ord, */
const seeded = [...sql.matchAll(
  /\n\s{2}\('([A-Z]+)',\s*'([^']*)',\s*'(description|reference|both)',\s*(NULL|'[^']*'),\s*(NULL|'[^']*')/g,
)].map((m) => ({
  acquirerCode: m[1],
  pattern: m[2],
  field: m[3],
  tradingDatePattern: m[4] === 'NULL' ? null : m[4].slice(1, -1),
  merchantPattern: m[5] === 'NULL' ? null : m[5].slice(1, -1),
}));

describe('the recognition rules shipped in migration 0305', () => {
  it('seeds a rule for every acquirer whose money the real files carry', () => {
    expect(seeded.map((r) => r.acquirerCode)).toEqual(['MBB', 'PBB', 'AEON', 'HLB']);
  });

  /* Every string below is copied out of a real statement, character for
     character — Maybank's from ACCOUNTACTIVITYREPORT_564418610346.csv
     (Houzs Century, 01-15 Aug 2026), Hong Leong's from account 23600602788
     (2990 HOME, 01-23 Jun 2026). */
  const REAL = [
    { desc: 'CR/CARD SALES MN 32410011 DATED 31072026', ref: '00113107', who: 'MBB', day: '2026-07-31', merchant: '32410011' },
    { desc: 'DR/CARD SALES M/N 2259020 DATED 08082026', ref: 'D90200808', who: 'MBB', day: '2026-08-08', merchant: '2259020' },
    { desc: '9205920432 CR/CARD SALES DATED 04082026', ref: '04320408', who: 'MBB', day: '2026-08-04' },
    { desc: '03999061714 PBB-PBCS AC 3', ref: '20260803000145', who: 'PBB' },
    { desc: 'Book Transfer Third AEON CREDIT SERVICE', ref: 'MA458030287507', who: 'AEON' },
    { desc: 'CA Credit Advice', ref: '00005992235  MERCHANT 20260616', who: 'HLB', day: '2026-06-16', merchant: '00005992235' },
  ];

  for (const c of REAL) {
    it(`recognises ${c.who} from "${c.desc.slice(0, 34)}"`, () => {
      const seen = recogniseAcquirer(seeded, { description: c.desc, reference: c.ref });
      expect(seen?.acquirerCode).toBe(c.who);
      /* The TRADING day the bank names, not the day the money landed — they
         differ by three days in the first row above. */
      if (c.day) expect(seen?.tradingDate).toBe(c.day);
      if (c.merchant) expect(seen?.merchantNo).toBe(c.merchant);
    });
  }

  /* A rule broad enough to swallow a customer transfer would reconcile it
     against a merchant statement and hide a real difference — the failure that
     costs more than not matching at all. */
  it('claims none of the ordinary banking around them', () => {
    for (const desc of [
      'CDM CASH DEPOSIT',
      'MBB TO HLBB BANK',
      'LAU LEE YEN        *',
      'MBB CT-             HO KAI YIN         *',
      'HV-PV-202607-0178 HOUZS VENTURE HO',
    ]) {
      expect(recogniseAcquirer(seeded, { description: desc, reference: 'Fund Transfer' })).toBeNull();
    }
  });
});
