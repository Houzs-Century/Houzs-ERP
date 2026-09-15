// The phone's pieces of money moved from a cancelled order (docs/bugs/0933):
// the method option joins the picker only while there is a cancelled order to
// draw on, the pick hands back what is left there, a converted row posts only
// its source and amount, and the sources come by order number for a saved
// order and by phone for the New SO screen — which has no order yet.
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useConvertSources, useCancelledWithMoney } = vi.hoisted(() => ({ useConvertSources: vi.fn(), useCancelledWithMoney: vi.fn() }));
vi.mock('../vendor/scm/lib/so-money-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useConvertSources, useCancelledWithMoney,
}));

import { ConvertSourceField, convertedBody, rmInput, useMobileConvertSources, withConvertOption } from './MobileOrderMoney';
import { CONVERT_LABEL, type ConvertSource } from '../vendor/scm/lib/so-money-queries';

afterEach(cleanup);

const SOURCES: ConvertSource[] = [
  { docNo: '2990-SO-2607-024', customer: 'Yap Kah Heng', cancelledOn: '2026-08-01', remainingSen: 336_500, bookedSen: 336_500 },
  { docNo: '2990-SO-2608-028', customer: 'Yap Kah Heng', cancelledOn: '2026-08-20', remainingSen: 143_300, bookedSen: 143_300 },
];
const CATALOG = [{ value: 'Cash', label: 'Cash' }, { value: 'Merchant', label: 'Merchant' }];

describe('the method option and the body', () => {
  it('joins the picker only when offered, once, after the catalog', () => {
    expect(withConvertOption(CATALOG, false)).toEqual(CATALOG);
    const offered = withConvertOption(CATALOG, true);
    expect(offered.map((o) => o.value)).toEqual(['Cash', 'Merchant', CONVERT_LABEL]);
    expect(withConvertOption(offered, true)).toHaveLength(3);
  });

  it('a converted row posts its source and amount and nothing else; sen becomes the box\'s RM string', () => {
    expect(convertedBody('2990-SO-2607-024', 336_500)).toEqual({ method: 'converted', convertedFromDocNo: '2990-SO-2607-024', amountSen: 336_500 });
    expect(convertedBody('', 100)).toEqual({ method: 'converted', convertedFromDocNo: null, amountSen: 100 });
    expect(rmInput(143_300)).toBe('1433.00');
    expect(rmInput(5)).toBe('0.05');
  });
});

describe('ConvertSourceField', () => {
  it('lists each cancelled order with what is left, hands back the pick and its remaining, keeps a stored value the list lost', () => {
    const onChange = vi.fn();
    render(<ConvertSourceField sources={SOURCES} value="" onChange={onChange} />);
    const sel = screen.getByLabelText('Cancelled order') as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['— Cancelled order —', '2990-SO-2607-024 · RM 3,365.00 left', '2990-SO-2608-028 · RM 1,433.00 left']);
    fireEvent.change(sel, { target: { value: '2990-SO-2608-028' } });
    expect(onChange).toHaveBeenCalledWith('2990-SO-2608-028', 143_300);
    cleanup();
    render(<ConvertSourceField sources={SOURCES} value="2990-SO-2605-001" onChange={onChange} />);
    const kept = screen.getByLabelText('Cancelled order') as HTMLSelectElement;
    expect(kept.value).toBe('2990-SO-2605-001');
    expect(kept.options).toHaveLength(4);
  });
});

describe('useMobileConvertSources', () => {
  it('a saved order asks by its number; the New SO screen asks by phone once six digits are typed', () => {
    useConvertSources.mockReturnValue({ data: { sources: [SOURCES[0]] } });
    useCancelledWithMoney.mockReturnValue({ data: { orders: SOURCES, totalRemainingSen: 479_800 } });
    const saved = renderHook(() => useMobileConvertSources({ docNo: '2990-SO-2609-050' }));
    expect(saved.result.current).toEqual([SOURCES[0]]);
    expect(useConvertSources).toHaveBeenLastCalledWith('2990-SO-2609-050');
    expect(useCancelledWithMoney).toHaveBeenLastCalledWith(null, false);

    const short = renderHook(() => useMobileConvertSources({ phone: '0123' }));
    expect(useCancelledWithMoney).toHaveBeenLastCalledWith('0123', false);
    expect(short.result.current).toEqual(SOURCES);

    renderHook(() => useMobileConvertSources({ phone: ' 0123456789 ' }));
    expect(useCancelledWithMoney).toHaveBeenLastCalledWith('0123456789', true);
    expect(useConvertSources).toHaveBeenLastCalledWith(null);
  });
});
