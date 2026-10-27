import { describe, expect, it } from 'vitest';
import { pickableBindings } from './pickable-bindings';
import type { BindingRow } from './suppliers-queries';

const bind = (id: string, item_code: string) => ({ id, item_code } as BindingRow);

describe('pickableBindings (HC-0153)', () => {
  it('drops a binding whose SKU is not in the active catalogue', () => {
    const bindings = [bind('b1', 'AK-SOLITUDE-Q'), bind('b2', 'HS-SOLITUDE-Q')];
    expect(pickableBindings(bindings, [{ code: 'HS-SOLITUDE-Q' }]).map((b) => b.id)).toEqual(['b2']);
  });

  it('keeps every binding when all its SKUs are active', () => {
    const bindings = [bind('b1', 'A'), bind('b2', 'B')];
    expect(pickableBindings(bindings, [{ code: 'A' }, { code: 'B' }])).toHaveLength(2);
  });
});
