import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('./authed-fetch', () => ({ authedFetch }));

import {
  useSgPostcodeLookup,
  isValidSgPostcode,
  sgAddressLine1,
  resolveSgPlanningArea,
  type SgAddress,
} from './sg-postcode-queries';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const addr = (o: Partial<SgAddress>): SgAddress => ({
  postcode: '', building: '', blockNo: '', road: '', address: '', lat: '', lng: '', planningArea: '', ...o,
});

// A slice of the seeded SG rows (mig 0181): city = planning area, state = region.
const SG_ROWS = [
  { country: 'Singapore', city: 'Orchard', state: 'Central' },
  { country: 'Singapore', city: 'Bukit Merah', state: 'Central' },
  { country: 'Singapore', city: 'Tampines', state: 'East' },
  { country: 'Malaysia', city: 'Orchard', state: 'Johor' }, // a same-named MY city must NOT win
];

beforeEach(() => authedFetch.mockReset());

describe('isValidSgPostcode', () => {
  it('accepts exactly six digits', () => {
    expect(isValidSgPostcode('238801')).toBe(true);
    expect(isValidSgPostcode(' 018956 ')).toBe(true);
    expect(isValidSgPostcode('23880')).toBe(false);
    expect(isValidSgPostcode('abcdef')).toBe(false);
  });
});

describe('sgAddressLine1', () => {
  it('prefers block+road, falls back to building then address', () => {
    expect(sgAddressLine1(addr({ blockNo: '2', road: 'ORCHARD TURN' }))).toBe('2 ORCHARD TURN');
    expect(sgAddressLine1(addr({ building: 'ION ORCHARD' }))).toBe('ION ORCHARD');
    expect(sgAddressLine1(addr({ address: '10 BAYFRONT AVENUE' }))).toBe('10 BAYFRONT AVENUE');
  });
});

describe('resolveSgPlanningArea', () => {
  it('maps a planning area (any case) to its seeded SG { state, city }', () => {
    expect(resolveSgPlanningArea(SG_ROWS, 'ORCHARD')).toEqual({ state: 'Central', city: 'Orchard' });
    expect(resolveSgPlanningArea(SG_ROWS, ' orchard ')).toEqual({ state: 'Central', city: 'Orchard' });
    expect(resolveSgPlanningArea(SG_ROWS, 'Tampines')).toEqual({ state: 'East', city: 'Tampines' });
  });
  it('only matches Singapore rows, so a same-named MY city cannot win', () => {
    // 'Orchard' exists under Malaysia/Johor too; the SG row is the one returned.
    expect(resolveSgPlanningArea(SG_ROWS, 'ORCHARD')?.state).toBe('Central');
  });
  it('returns null for a blank area or one not among the seeded SG cities', () => {
    expect(resolveSgPlanningArea(SG_ROWS, '')).toBeNull();
    expect(resolveSgPlanningArea(SG_ROWS, 'WESTERN WATER CATCHMENT')).toBeNull(); // real area, not in this slice
    expect(resolveSgPlanningArea([], 'ORCHARD')).toBeNull();
  });
});

describe('useSgPostcodeLookup', () => {
  it('does not fetch for an invalid (non 6-digit) code', () => {
    renderHook(() => useSgPostcodeLookup('23'), { wrapper });
    expect(authedFetch).not.toHaveBeenCalled();
  });

  it('fetches /sg-postcode/:code for a valid code and returns the address', async () => {
    authedFetch.mockResolvedValue({
      configured: true,
      results: [addr({ postcode: '238801', building: 'ION ORCHARD', blockNo: '2', road: 'ORCHARD TURN', address: '2 ORCHARD TURN ION ORCHARD SINGAPORE 238801' })],
    });
    const { result } = renderHook(() => useSgPostcodeLookup('238801'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(authedFetch).toHaveBeenCalledWith('/sg-postcode/238801');
    expect(result.current.data?.configured).toBe(true);
    expect(result.current.data?.results[0].building).toBe('ION ORCHARD');
  });

  it('passes { configured:false } through so callers can degrade', async () => {
    authedFetch.mockResolvedValue({ configured: false, results: [] });
    const { result } = renderHook(() => useSgPostcodeLookup('018956'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.configured).toBe(false);
  });
});
