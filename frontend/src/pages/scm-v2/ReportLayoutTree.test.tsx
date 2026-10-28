// The statement tree with hand-opened rows: a category folds and unfolds by
// its chevron past the level, an account's name opens its lines for the
// period under its row (the ledger's own read), a figure still opens the GL.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';

const { useLedger } = vi.hoisted(() => ({ useLedger: vi.fn() }));
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useLedger }));

import { LaidBlock, useReportTree, type Level } from './ReportLayoutTree';

const acc = (code: string, name: string, sen: number): LaidNode => ({ kind: 'account', id: `acc:${code}`, label: `${code} — ${name}`, code, amountSen: sen, pct: 10, children: [] });
const NODES: LaidNode[] = [
  { kind: 'category', id: 'opex', label: 'OPERATING EXPENSE', amountSen: 150_000, pct: 15, children: [
    { kind: 'category', id: 'advert', label: 'ADVERTISEMENT', amountSen: 30_000, pct: 3, children: [acc('900-A014', 'FACEBOOK ADS', 30_000)] },
    acc('900-A001', 'RENTAL', 120_000),
  ] },
];

const Tree = ({ level, onPick }: { level: Level; onPick?: (n: LaidNode) => void }) => {
  const tree = useReportTree(level);
  return (
    <MemoryRouter>
      <table><tbody>
        <LaidBlock title="Expenses" nodes={NODES} level={level} totalLabel="Total expenses" totalSen={150_000} baseSen={1_000_000} onPick={onPick} tree={tree} drill={{ from: '2026-08-01', to: '2026-08-31' }} />
      </tbody></table>
    </MemoryRouter>
  );
};

beforeEach(() => {
  useLedger.mockReturnValue({ data: { blocks: [{ code: '900-A001', name: 'RENTAL', type: 'EXPENSE', openingSen: 0, debitSen: 120_000, creditSen: 0, closingSen: 120_000, lines: [
    { lineId: 'l1', date: '2026-08-05', jeNo: '2990-JE-2608-0002', journal: 'BANK', counter: { code: '310-0010', name: 'CASH AT BANK - MAYBANK', more: 0 }, doc: '2990-HPV-2608-017', doc2: null, description: 'Rent August', who: 'LANDLORD', debitSen: 120_000, creditSen: 0, balanceSen: 120_000, reversal: '' },
  ] }], totals: { debitSen: 120_000, creditSen: 0 } }, isLoading: false, isError: false });
});
afterEach(cleanup);

const labels = () => screen.getAllByRole('row').map((r) => r.textContent);

describe('the tree', () => {
  it('L1 folds the categories; a chevron opens one of them past the level, and closes it again', () => {
    render(<Tree level={1} />);
    expect(labels().some((t) => t.includes('RENTAL'))).toBe(false);
    const opex = screen.getByRole('button', { name: 'Expand OPERATING EXPENSE' });
    expect(opex.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(opex);
    expect(labels().some((t) => t.includes('900-A001 — RENTAL'))).toBe(true);
    expect(labels().some((t) => t.includes('ADVERTISEMENT'))).toBe(true);
    /* The child category stays folded by the level until its own chevron. */
    expect(labels().some((t) => t.includes('FACEBOOK'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Expand ADVERTISEMENT' }));
    expect(labels().some((t) => t.includes('900-A014 — FACEBOOK ADS'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse OPERATING EXPENSE' }));
    expect(labels().some((t) => t.includes('RENTAL'))).toBe(false);
  });

  it("an account's name opens its lines for the period under the row; the figure still opens the ledger", () => {
    const onPick = vi.fn();
    render(<Tree level="all" onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENTAL' }));
    expect(useLedger).toHaveBeenLastCalledWith({ from: '2026-08-01', to: '2026-08-31', accounts: ['900-A001'] });
    const drill = document.querySelector('tr[data-lines-of="900-A001"]') as HTMLElement;
    expect(drill).not.toBeNull();
    expect(within(drill).getByText('Rent August')).toBeTruthy();
    expect(within(drill).getByText('310-0010 CASH AT BANK - MAYBANK')).toBeTruthy();
    expect(within(drill).getByText('2990-HPV-2608-017')).toBeTruthy();
    expect(within(drill).getByText(/共 1 笔/)).toBeTruthy();
    expect((within(drill).getByRole('link', { name: '在 GL 打开' }) as HTMLAnchorElement).getAttribute('href')).toBe('/scm/accounting?tab=gl&accounts=900-A001&from=2026-08-01&to=2026-08-31');
    /* The figure keeps its own door. */
    fireEvent.click(screen.getByRole('button', { name: '900-A001 — RENTAL total' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    /* Closed again by the name. */
    fireEvent.click(screen.getByRole('button', { name: 'Lines of 900-A001 — RENTAL' }));
    expect(document.querySelector('tr[data-lines-of="900-A001"]')).toBeNull();
  });

  it('a new level clears what was opened by hand', () => {
    const { rerender } = render(<Tree level={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand OPERATING EXPENSE' }));
    expect(labels().some((t) => t.includes('RENTAL'))).toBe(true);
    rerender(<Tree level={1} />);
    expect(labels().some((t) => t.includes('RENTAL'))).toBe(true);
  });
});
