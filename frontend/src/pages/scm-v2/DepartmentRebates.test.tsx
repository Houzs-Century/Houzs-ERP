/* The selling department's supplier rebates box (owner 2026-11-27: 「做设定框」 — Finance
 * types the supplier's terms once), with a made-up supplier and terms. Pinned:
 *   • percentages and RM on screen, basis points and sen on the wire, both ways;
 *   • a rule with a wrong figure is held back with what to fix, never sent;
 *   • nothing set reads "none set" and offers Set up; a blank form saves no rule;
 *   • a saved rule reads back in one line and opens filled in. */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Rule = import('../../vendor/scm/lib/department-queries').SupplierRebateRule;
const RULE: Rule = {
  supplierCode: '400-R001', label: 'REBATE CO', sponsorBp: 1200, namedWords: ['ALPHA', 'BETA'], accessoryWords: ['PILLOW'],
  salesTiers: [{ fromSen: 8_000_000, bp: 200 }, { fromSen: 16_000_000, bp: 400 }], displayDiscountBp: 4000,
};

const mutate = vi.fn((_rules: Rule[], opts?: { onSuccess?: () => void }) => { opts?.onSuccess?.(); });
vi.mock('../../vendor/scm/lib/department-queries', async (orig) => ({
  ...(await orig<typeof import('../../vendor/scm/lib/department-queries')>()),
  useSaveSupplierRebates: () => ({ mutate, isPending: false }),
}));

const { SupplierRebatesBox, blankDraft, fromDraft, isBlankDraft, ruleSummary, toDraft } = await import('./DepartmentRebates');

beforeEach(() => { mutate.mockClear(); });

describe('the rule as the form holds it', () => {
  it('round-trips: % and RM on screen, basis points and sen on the wire', () => {
    const d = toDraft(RULE);
    expect(d).toMatchObject({ sponsorPct: '12', namedWords: 'ALPHA, BETA', displayPct: '40', tiers: [{ fromRm: '80000', pct: '2' }, { fromRm: '160000', pct: '4' }] });
    expect(fromDraft(d)).toEqual({ ok: true, rule: RULE });
    expect(fromDraft({ ...d, supplierCode: ' 400-r001 ', namedWords: 'alpha, ,beta,alpha', tiers: [...d.tiers, { fromRm: '', pct: '' }] })).toEqual({ ok: true, rule: RULE });
    expect(fromDraft({ ...d, tiers: [{ fromRm: '100,000.50', pct: '2.5' }] })).toMatchObject({ ok: true, rule: { salesTiers: [{ fromSen: 10_000_050, bp: 250 }] } });
  });

  it('holds back a wrong figure with what to fix', () => {
    const d = toDraft(RULE);
    const why = (over: Partial<ReturnType<typeof toDraft>>) => { const r = fromDraft({ ...d, ...over }); return r.ok ? null : r.message; };
    expect(why({ supplierCode: '' })).toMatch(/supplier.s code/);
    expect(why({ sponsorPct: '101' })).toBe('400-R001: the sponsor rebate is a percentage from 0 to 100, two decimals at most.');
    expect(why({ displayPct: '2.555' })).toMatch(/display discount is a percentage/);
    expect(why({ tiers: [{ fromRm: '100000', pct: '' }] })).toMatch(/each sales rebate tier needs/);
    expect(why({ tiers: [{ fromRm: 'abc', pct: '3' }] })).toMatch(/each sales rebate tier needs/);
  });

  it('a blank form is no rule; one line reads a rule back', () => {
    expect(isBlankDraft(blankDraft())).toBe(true);
    expect(isBlankDraft({ ...blankDraft(), sponsorPct: '1' })).toBe(false);
    expect(ruleSummary(RULE)).toBe('REBATE CO (400-R001) · sponsor 12% less ALPHA, BETA and accessories · sales 2% from RM 80,000, 4% from RM 160,000 less display sets · display discount 40%');
  });
});

describe('SupplierRebatesBox', () => {
  it('nothing set: "none set", Set up opens a blank form, typed terms are saved as the server takes them', () => {
    render(<SupplierRebatesBox rules={[]} />);
    expect(screen.getByText(/none set\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    type('Supplier 1 code', '400-r001');
    type('Supplier 1 name shown', 'REBATE CO');
    type('Supplier 1 sponsor rebate %', '12');
    type('Supplier 1 products left out', 'alpha, beta');
    type('Supplier 1 accessory words', 'pillow');
    type('Supplier 1 tier 1 from RM', '80000');
    type('Supplier 1 tier 1 rate %', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Add tier' }));
    type('Supplier 1 tier 2 from RM', '160000');
    type('Supplier 1 tier 2 rate %', '4');
    type('Supplier 1 display discount %', '40');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toEqual([RULE]);
    expect(screen.queryByRole('group', { name: 'Supplier rebate rules' })).toBeNull();
  });

  it('a wrong figure is shown and nothing is sent', () => {
    render(<SupplierRebatesBox rules={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    fireEvent.change(screen.getByLabelText('Supplier 1 code'), { target: { value: '400-R001' } });
    fireEvent.change(screen.getByLabelText('Supplier 1 sponsor rebate %'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert').textContent).toBe('400-R001: the sponsor rebate is a percentage from 0 to 100, two decimals at most.');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('a saved rule reads back in one line, opens filled in, and removing it saves none', () => {
    render(<SupplierRebatesBox rules={[RULE]} />);
    expect(screen.getByText(/REBATE CO \(400-R001\) · sponsor 12%/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByLabelText('Supplier 1 code') as HTMLInputElement).value).toBe('400-R001');
    expect((screen.getByLabelText('Supplier 1 tier 2 rate %') as HTMLInputElement).value).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Remove supplier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate.mock.calls[0]![0]).toEqual([]);
  });
});
