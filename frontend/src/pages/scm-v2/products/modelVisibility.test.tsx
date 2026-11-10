/* Modular hides a Model whose codes are all off (a merge leftover such as
 * "AMIRA PREMUIM") unless Show inactive is on, and the choice lives in the URL. */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { ShowInactiveModelsToggle, isLeftoverModel, skuCountText, visibleModels } from './modelVisibility';

const leftover = { active: false, sku_count: 4, active_sku_count: 0 };
const live = { active: true, sku_count: 3, active_sku_count: 3 };
const newEmpty = { active: true, sku_count: 0, active_sku_count: 0 };
const offButEmpty = { active: false, sku_count: 0, active_sku_count: 0 };

describe('Modular visibility', () => {
  test('hides Models with no active code by default, keeps a new empty Model', () => {
    expect(visibleModels([leftover, live, newEmpty, offButEmpty], false)).toEqual([live, newEmpty]);
    expect(visibleModels([leftover, live, newEmpty, offButEmpty], true)).toHaveLength(4);
    expect(isLeftoverModel({ active: true, sku_count: 2, active_sku_count: 0 })).toBe(true);
    expect(isLeftoverModel({ active: false, sku_count: 2 })).toBe(false);
  });

  test('the count says how many codes are on when some are off', () => {
    expect(skuCountText(live)).toBe('3');
    expect(skuCountText({ active: true, sku_count: 5, active_sku_count: 2 })).toBe('2 of 5 on');
  });

  test('the toggle writes showInactive=1 into the URL and clears it again', () => {
    let search = '';
    const Spy = () => { search = useLocation().search; return null; };
    render(<MemoryRouter initialEntries={['/product-models']}><ShowInactiveModelsToggle hidden={2} /><Spy /></MemoryRouter>);
    expect(screen.getByText('Show inactive (2 hidden)')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(search).toBe('?showInactive=1');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(search).toBe('');
  });
});
