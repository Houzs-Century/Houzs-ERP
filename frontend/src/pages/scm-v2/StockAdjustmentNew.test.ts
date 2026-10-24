/* HC-0141: found stock on a code with no lots was refused (cost_required) because
 * the form had no way to send the unit cost the server asks for. */
import { describe, it, expect } from 'vitest';
import { blankLine, lineInput } from './StockAdjustmentNew';

const line = (qty: number, costRm: number | null) => ({ ...blankLine(), itemCode: 'MYLATEX BACKSHIRE MATT (Q)', reasonCode: 'FOUND', qty, costRm });

describe('stock adjustment line payload', () => {
  it('sends the typed unit cost in sen on an increase', () => {
    expect(lineInput(line(1, 1200)).unitCostSen).toBe(120000);
    expect(lineInput(line(1, 29.645)).unitCostSen).toBe(2965);
  });

  it('sends no cost when blank, and never on a write-off', () => {
    expect(lineInput(line(1, null)).unitCostSen).toBeUndefined();
    expect(lineInput(line(-1, 1200)).unitCostSen).toBeUndefined();
  });
});
