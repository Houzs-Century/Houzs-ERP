// Every match_reason the bank code writes must be a word the database's check
// (acc_bank_match_reason) accepts. 2026-11-17: the QR credits that match
// themselves wrote "qr+report" before the check knew it, and production refused
// the first one — "violates check constraint acc_bank_match_reason" — while
// every suite passed, because the fake database does not enforce checks. This
// reads the newest migration that sets the check and the code that writes the
// column, so a new reason cannot ship without its migration.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const MIGRATIONS = new URL('../src/db/migrations-pg/', import.meta.url);
const WRITERS = ['../src/scm/routes/accounting-bank.ts'].map((p) => new URL(p, import.meta.url));

const allowedReasons = (): string[] => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const setting = files.filter((f) => /ADD CONSTRAINT acc_bank_match_reason/i.test(readFileSync(new URL(f, MIGRATIONS), 'utf8')));
  const latest = setting.at(-1);
  if (!latest) throw new Error('no migration sets acc_bank_match_reason');
  const body = readFileSync(new URL(latest, MIGRATIONS), 'utf8').split(/ADD CONSTRAINT acc_bank_match_reason/i).at(-1)!;
  const check = body.slice(0, body.indexOf(';'));
  return [...check.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
};

const writtenReasons = (): string[] => {
  const out = new Set<string>();
  for (const file of WRITERS) {
    for (const m of readFileSync(file, 'utf8').matchAll(/match_reason:\s*([^,}\n]+)/g)) {
      for (const q of m[1]!.matchAll(/'([^']+)'/g)) out.add(q[1]!);
    }
  }
  return [...out].sort();
};

describe("the bank's match reasons and the database's check", () => {
  test('every reason the code writes is one the check accepts', () => {
    const allowed = allowedReasons();
    const written = writtenReasons();
    expect(written).toEqual(expect.arrayContaining(['manual', 'amount+name', 'amount+document', 'qr+report']));
    expect(written.filter((r) => !allowed.includes(r))).toEqual([]);
  });
});
