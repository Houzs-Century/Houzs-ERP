/* PoPriceReference — the purchase order's price shown beside the invoice price
   (owner 2026-09-14: 「能直接看到这个 PI 的价钱，以及之前在 PO 里的价钱是多少」).
   Information only: it never blocks and never asks. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { PoPriceReference } from './PoPriceReference';

afterEach(cleanup);
const fmt = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

describe('PoPriceReference', () => {
  test('shows the PO price and the difference when the invoice price differs', () => {
    render(<PoPriceReference poUnitPriceSen={80_000} piUnitPriceSen={83_000} fmt={fmt} />);
    expect(screen.getByText('PO RM 800.00')).toBeTruthy();
    expect(screen.getByText('+RM 30.00 vs PO')).toBeTruthy();
  });

  test('a lower invoice price is shown with a minus, same weight', () => {
    render(<PoPriceReference poUnitPriceSen={80_000} piUnitPriceSen={77_000} fmt={fmt} />);
    expect(screen.getByText('−RM 30.00 vs PO')).toBeTruthy();
  });

  test('matching prices say nothing extra', () => {
    render(<PoPriceReference poUnitPriceSen={80_000} piUnitPriceSen={80_000} fmt={fmt} />);
    expect(screen.getByText('PO RM 800.00')).toBeTruthy();
    expect(screen.queryByText(/vs PO/)).toBeNull();
  });

  test('an order that named no price says so, and is not a difference', () => {
    render(<PoPriceReference poUnitPriceSen={0} piUnitPriceSen={213_800} fmt={fmt} />);
    expect(screen.getByText('PO had no price')).toBeTruthy();
    expect(screen.queryByText(/vs PO/)).toBeNull();
  });

  test('no purchase order behind the line -> "no PO link", never a number', () => {
    render(<PoPriceReference poUnitPriceSen={null} piUnitPriceSen={5_000} fmt={fmt} />);
    expect(screen.getByText('no PO link')).toBeTruthy();
  });
});
