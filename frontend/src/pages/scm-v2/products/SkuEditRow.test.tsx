/* The SKU Master "Edit Prices" row keeps what the operator typed ON SCREEN
 * until Save or Cancel (owner 2026-09-15: he changed "RDS BOLSTER 810" to
 * "BOLSTER 810", and a moment later the row showed "RDS BOLSTER 810" again).
 * The harness holds staged edits exactly the way SkuMasterTab does: merged by
 * row id, nothing sent anywhere. */
import { fireEvent, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { MfgProductRow } from '../../../vendor/scm/lib/mfg-products-queries';
import { ProductRow, stageRowEdit, type ProductEditPatch } from './SkuEditRow';

const baseRow: MfgProductRow = {
  id: 'mfg-1',
  code: '810 BOLSTER',
  name: 'RDS BOLSTER 810',
  category: 'ACCESSORY',
  base_price_sen: 5000,
  price1_sen: null,
  status: 'ACTIVE',
  unit_m3_milli: 0,
  branding: 'RDS',
  seat_height_prices: [
    { height: '24', priceSen: 100000, tier: 'PRICE_2' },
    { height: '24', priceSen: 90000, tier: 'PRICE_1' },
  ],
};

function Harness({ row = baseRow, tier = 'PRICE_2', view = 'default' }: {
  row?: MfgProductRow;
  tier?: 'PRICE_1' | 'PRICE_2' | 'PRICE_3';
  view?: 'default' | 'sofa' | 'mattress';
}) {
  const [pending, setPending] = useState<Record<string, ProductEditPatch>>({});
  const onStage = useCallback((id: string, patch: ProductEditPatch) => {
    setPending((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);
  return (
    <table>
      <tbody>
        <ProductRow
          row={row}
          editMode
          isSofaView={view === 'sofa'}
          isMattressView={view === 'mattress'}
          sofaSizes={['24']}
          tier={tier}
          selected={false}
          onToggleSelected={() => {}}
          patch={pending[row.id]}
          onStage={onStage}
          brandingPool={['RDS', 'OTHER']}
        />
      </tbody>
    </table>
  );
}

const editText = (current: string, next: string) => {
  fireEvent.click(screen.getByText(current));
  const input = screen.getByDisplayValue(current);
  fireEvent.change(input, { target: { value: next } });
  fireEvent.blur(input);
};

describe('SKU Master edit row keeps the typed value until Save', () => {
  it('a changed description stays on screen after leaving the cell', () => {
    render(<Harness />);
    editText('RDS BOLSTER 810', 'BOLSTER 810');
    expect(screen.getByText('BOLSTER 810')).toBeTruthy();
    expect(screen.queryByText('RDS BOLSTER 810')).toBeNull();
  });

  it('re-opening the cell edits the staged value, not the stored one', () => {
    render(<Harness />);
    editText('RDS BOLSTER 810', 'BOLSTER 810');
    fireEvent.click(screen.getByText('BOLSTER 810'));
    expect(screen.getByDisplayValue('BOLSTER 810')).toBeTruthy();
  });

  it('a changed product code stays on screen after leaving the cell', () => {
    render(<Harness />);
    editText('810 BOLSTER', 'BOLSTER-810');
    expect(screen.getByText('BOLSTER-810')).toBeTruthy();
    expect(screen.queryByText('810 BOLSTER')).toBeNull();
  });

  it('clearing a mattress branding shows it cleared, not the stored brand', () => {
    render(<Harness view="mattress" />);
    const select = screen.getByDisplayValue('RDS') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('');
  });

  it('switching the sofa tier shows that tier\'s price, not the last tier\'s', () => {
    const { rerender } = render(<Harness view="sofa" tier="PRICE_2" />);
    expect(screen.getByDisplayValue('1000.00')).toBeTruthy();
    rerender(<Harness view="sofa" tier="PRICE_1" />);
    expect(screen.getByDisplayValue('900.00')).toBeTruthy();
    expect(screen.queryByDisplayValue('1000.00')).toBeNull();
  });
});

describe('stageRowEdit — the Save count means real changes', () => {
  it('keeps a real change', () => {
    expect(stageRowEdit({}, baseRow, 'mfg-1', { name: 'BOLSTER 810' })).toEqual({ 'mfg-1': { name: 'BOLSTER 810' } });
  });

  it('drops a field typed back to the stored value, and the row with it', () => {
    const once = stageRowEdit({}, baseRow, 'mfg-1', { name: 'BOLSTER 810' });
    expect(stageRowEdit(once, baseRow, 'mfg-1', { name: 'RDS BOLSTER 810' })).toEqual({});
  });

  it('tabbing through an unchanged price stages nothing', () => {
    expect(stageRowEdit({}, baseRow, 'mfg-1', { basePriceSen: 5000 })).toEqual({});
    expect(stageRowEdit({}, baseRow, 'mfg-1', { price1Sen: null })).toEqual({});
  });

  it('a cleared price or branding is a change', () => {
    expect(stageRowEdit({}, baseRow, 'mfg-1', { basePriceSen: null })).toEqual({ 'mfg-1': { basePriceSen: null } });
    expect(stageRowEdit({}, baseRow, 'mfg-1', { branding: null })).toEqual({ 'mfg-1': { branding: null } });
  });

  it('a seat price list that only changed order is not a change', () => {
    const reordered = [...(baseRow.seat_height_prices ?? [])].reverse();
    expect(stageRowEdit({}, baseRow, 'mfg-1', { seatHeightPrices: reordered })).toEqual({});
  });

  it('other rows are untouched', () => {
    const prev = { other: { name: 'X' } };
    expect(stageRowEdit(prev, baseRow, 'mfg-1', { name: 'BOLSTER 810' })).toEqual({ other: { name: 'X' }, 'mfg-1': { name: 'BOLSTER 810' } });
  });
});
