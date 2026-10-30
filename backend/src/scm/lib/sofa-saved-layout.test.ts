import { describe, expect, it } from 'vitest';
import { comboAccessoriesKey, validateComboAccessories, validateSofaSavedLayout } from './sofa-saved-layout';

const layout = () => ({
  cells: [
    { id: 'left', moduleId: '2NA', x: 100, y: 90, rot: 90 },
    { id: 'right', moduleId: '1NA', x: 195, y: 90, rot: 0 },
  ],
  accessories: [{ id: 'back', modelId: 'cushion', cellId: 'left', slot: 0,
    fabric: { fabricId: 'CG', colourId: 'CG-001', fabricLabel: 'CG', colourLabel: 'Sand', colourHex: '#bbaa88' } }],
});
const modules = [['2NA'], ['1NA']];

describe('saved sofa layout validation', () => {
  it('retains geometry, attachments and accessory colour', () => {
    const saved = layout();
    expect(validateSofaSavedLayout(saved, modules)).toEqual(saved);
  });
  it('keeps legacy picks valid without a snapshot', () => {
    expect(validateSofaSavedLayout(undefined, modules)).toBeNull();
  });
  it('rejects a snapshot whose modules disagree with the pick', () => {
    expect(validateSofaSavedLayout(layout(), [['1S'], ['3S']])).toBe(false);
  });
  it('rejects orphaned pieces and duplicate ids', () => {
    const saved = layout();
    saved.accessories[0]!.cellId = 'missing';
    expect(validateSofaSavedLayout(saved, modules)).toBe(false);
    const duplicate = layout();
    duplicate.accessories.push(duplicate.accessories[0]!);
    expect(validateSofaSavedLayout(duplicate, modules)).toBe(false);
  });
});

describe('stored combo accessory identity', () => {
  it('normalizes quantities by Model and distinguishes a bare sofa', () => {
    const split = [{ modelId: 'back', qty: 1 }, { modelId: 'arm', qty: 1 }, { modelId: 'back', qty: 2 }];
    expect(validateComboAccessories(split)).toEqual([{ modelId: 'arm', qty: 1 }, { modelId: 'back', qty: 3 }]);
    expect(comboAccessoriesKey(split)).toBe(comboAccessoriesKey([{ modelId: 'back', qty: 3 }, { modelId: 'arm', qty: 1 }]));
    expect(comboAccessoriesKey(split)).not.toBe(comboAccessoriesKey(undefined));
  });
  it.each([0, -1, 0.5, 201, Infinity])('rejects invalid accessory quantity %s', (qty) => {
    expect(validateComboAccessories([{ modelId: 'back', qty }])).toBeNull();
  });
});
