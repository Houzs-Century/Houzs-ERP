/* PUT /journal-entries/:id — a manual journal edited in one step (owner
   2026-09-15 on a POSTED manual journal: 我无法 edit). Pinned:
     · a posted entry: the corrected entry is posted under a new number, the
       old one is reversed by a contra dated the OLD entry's own day whose
       narration names the successor, and the response carries all three;
     · a bad edit (unbalanced, a control account) reverses NOTHING — the
       refusal comes before any write;
     · a draft is rewritten in place — same number, no contra;
     · a document's entry and a reversed entry are refused by name; a caller
       without the GL key gets 403; another company's entry reads as absent. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { journalEntryEdit } from '../src/scm/routes/accounting-journal-edit';

const GL_PERM = 'scm.payment_voucher.post';
const CO = 2;

const CHART: Row[] = [
  { account_code: '900-S100', account_name: 'GROSS SALARY', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: CO },
  { account_code: '900-S500', account_name: 'STAFF ALLOWANCE', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: CO },
  { account_code: '410-0010', account_name: 'SALARY PAYABLE', account_type: 'LIABILITY', parent_code: null, is_active: true, company_id: CO },
  { account_code: '300-0000', account_name: 'ACCOUNTS RECEIVABLE', account_type: 'ASSET', parent_code: null, is_active: true, company_id: CO },
];

const posted = (): Row[] => [
  { id: 'je-163', je_no: '2990-JE-2606-0163', entry_date: '2026-06-30', source_type: 'MANUAL', source_doc_no: null, narration: "Salary - Jun'26",
    total_debit_sen: 1920698, total_credit_sen: 1920698, posted: true, reversed: false, reversed_by_je: null, company_id: CO },
];
const postedLines = (): Row[] => [
  { id: 'l1', journal_entry_id: 'je-163', line_no: 1, account_code: '900-S100', debit_sen: 1920698, credit_sen: 0, party_type: null, party_code: null, party_name: null, notes: "Gross Salary - Jun'26", company_id: CO },
  { id: 'l2', journal_entry_id: 'je-163', line_no: 2, account_code: '410-0010', debit_sen: 0, credit_sen: 1920698, party_type: null, party_code: null, party_name: null, notes: "Net Salary - Jun'26", company_id: CO },
];

const world = (over: { jes?: Row[]; lines?: Row[]; perms?: string[]; companyId?: number | undefined } = {}) => {
  const sb = fakeSb({
    accounts: CHART,
    journal_entries: over.jes ?? posted(),
    journal_entry_lines: over.lines ?? postedLines(),
    acc_account_roles: [{ company_id: CO, role: 'AR', account_code: '300-0000' }],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, ('companyId' in over ? over.companyId : CO) as never);
    c.set('houzsUser' as never, { permissions_set: over.perms ?? [GL_PERM] } as never);
    await next();
  });
  app.put('/journal-entries/:id', journalEntryEdit as never);
  return { app, sb };
};

const put = (app: Hono, id: string, body: unknown) =>
  app.request(`/journal-entries/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const corrected = {
  entryDate: '2026-06-30',
  narration: "Salary - Jun'26 (corrected)",
  lines: [
    { accountCode: '900-S100', debitSen: 1900000, creditSen: 0, notes: 'Gross' },
    { accountCode: '900-S500', debitSen: 20698, creditSen: 0, notes: 'Allowance' },
    { accountCode: '410-0010', debitSen: 0, creditSen: 1920698, notes: 'Net' },
  ],
};

describe('a posted manual journal edited', () => {
  test('the corrected entry is posted under a new number, the old one reversed on its own day, the contra naming the successor', async () => {
    const { app, sb } = world();
    const res = await put(app, 'je-163', corrected);
    expect(res.status).toBe(200);
    const out = await res.json() as { journalEntry: Row; lineCount: number; replaced: { originalJeNo: string; originalJeId: string; contraJeNo: string } };
    expect(out.lineCount).toBe(3);
    expect(out.replaced.originalJeNo).toBe('2990-JE-2606-0163');
    expect(out.replaced.originalJeId).toBe('je-163');

    const jes = sb.tables.journal_entries as Row[];
    expect(jes).toHaveLength(3);
    const old = jes.find((r) => r.id === 'je-163')!;
    expect(old.reversed).toBe(true);
    const contra = jes.find((r) => r.source_type === 'MANUAL_REVERSAL')!;
    expect(contra.entry_date).toBe('2026-06-30');
    expect(contra.reversed_by_je).toBe('je-163');
    expect(contra.posted).toBe(true);
    expect(old.reversed_by_je).toBe(contra.id);
    const fresh = jes.find((r) => r.source_type === 'MANUAL' && r.id !== 'je-163')!;
    expect(fresh.posted).toBe(true);
    expect(fresh.narration).toBe("Salary - Jun'26 (corrected)");
    expect(fresh.entry_date).toBe('2026-06-30');
    expect(String(fresh.je_no)).not.toBe('2990-JE-2606-0163');
    expect(out.journalEntry.je_no).toBe(fresh.je_no);
    expect(out.replaced.contraJeNo).toBe(contra.je_no);
    expect(String(contra.narration)).toBe(`Reversal of 2990-JE-2606-0163 — edited, replaced by ${fresh.je_no}`);

    const lines = sb.tables.journal_entry_lines as Row[];
    const freshLines = lines.filter((l) => l.journal_entry_id === fresh.id);
    expect(freshLines.map((l) => [l.account_code, l.debit_sen, l.credit_sen, l.notes])).toEqual([
      ['900-S100', 1900000, 0, 'Gross'], ['900-S500', 20698, 0, 'Allowance'], ['410-0010', 0, 1920698, 'Net'],
    ]);
    const contraLines = lines.filter((l) => l.journal_entry_id === contra.id);
    expect(contraLines.map((l) => [l.account_code, l.debit_sen, l.credit_sen])).toEqual([['900-S100', 0, 1920698], ['410-0010', 1920698, 0]]);
    /* The old entry's own lines are untouched — history stays readable. */
    expect(lines.filter((l) => l.journal_entry_id === 'je-163')).toHaveLength(2);
  });

  test('a blank date keeps the entry on its own day; a new date moves the corrected entry, never the contra', async () => {
    const { app, sb } = world();
    const res = await put(app, 'je-163', { ...corrected, entryDate: '2026-07-02' });
    expect(res.status).toBe(200);
    const jes = sb.tables.journal_entries as Row[];
    expect(jes.find((r) => r.source_type === 'MANUAL_REVERSAL')!.entry_date).toBe('2026-06-30');
    const fresh = jes.find((r) => r.source_type === 'MANUAL' && r.id !== 'je-163')!;
    expect(fresh.entry_date).toBe('2026-07-02');
    expect(String(fresh.je_no)).toContain('2607');
  });

  test('a bad edit reverses nothing: unbalanced, a control account, one line', async () => {
    const { app, sb } = world();
    const unbalanced = await put(app, 'je-163', { ...corrected, lines: [corrected.lines[0], corrected.lines[2]] });
    expect(unbalanced.status).toBe(400);
    expect((await unbalanced.json()).error).toBe('unbalanced');
    const control = await put(app, 'je-163', { ...corrected, lines: [
      { accountCode: '300-0000', debitSen: 1920698, creditSen: 0 }, { accountCode: '410-0010', debitSen: 0, creditSen: 1920698 },
    ] });
    expect(control.status).toBe(400);
    expect((await control.json()).error).toBe('control_account_manual');
    const one = await put(app, 'je-163', { ...corrected, lines: [corrected.lines[2]] });
    expect(one.status).toBe(400);
    expect((await one.json()).error).toBe('min_2_lines');
    const jes = sb.tables.journal_entries as Row[];
    expect(jes).toHaveLength(1);
    expect(jes[0]!.reversed).toBe(false);
    expect(sb.tables.journal_entry_lines).toHaveLength(2);
  });
});

describe('what an edit refuses, and a draft', () => {
  test('a draft is rewritten in place — same number, no contra', async () => {
    const { app, sb } = world({ jes: [{ ...posted()[0]!, posted: false }] });
    const res = await put(app, 'je-163', corrected);
    expect(res.status).toBe(200);
    const out = await res.json() as { journalEntry: Row; replaced: null };
    expect(out.replaced).toBeNull();
    expect(out.journalEntry.je_no).toBe('2990-JE-2606-0163');
    const jes = sb.tables.journal_entries as Row[];
    expect(jes).toHaveLength(1);
    expect(jes[0]).toMatchObject({ posted: false, reversed: false, narration: "Salary - Jun'26 (corrected)", total_debit_sen: 1920698 });
    const lines = sb.tables.journal_entry_lines as Row[];
    expect(lines.map((l) => [l.journal_entry_id, l.line_no, l.account_code, l.debit_sen, l.credit_sen])).toEqual([
      ['je-163', 1, '900-S100', 1900000, 0], ['je-163', 2, '900-S500', 20698, 0], ['je-163', 3, '410-0010', 0, 1920698],
    ]);
  });

  test("a document's entry, a reversed entry, another company's entry, and a caller without the key", async () => {
    const doc = world({ jes: [{ ...posted()[0]!, source_type: 'SOPAY', source_doc_no: 'pay-1' }] });
    const r1 = await put(doc.app, 'je-163', corrected);
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toBe('not_manual');

    const rev = world({ jes: [{ ...posted()[0]!, reversed: true }] });
    const r2 = await put(rev.app, 'je-163', corrected);
    expect(r2.status).toBe(409);
    expect((await r2.json()).error).toBe('already_reversed');

    const other = world({ jes: [{ ...posted()[0]!, company_id: 1 }] });
    const r3 = await put(other.app, 'je-163', corrected);
    expect(r3.status).toBe(404);
    expect((await r3.json()).error).toBe('not_found_in_company');

    const noKey = world({ perms: [] });
    const r4 = await put(noKey.app, 'je-163', corrected);
    expect(r4.status).toBe(403);
    expect(noKey.sb.tables.journal_entries).toHaveLength(1);
  });
});
