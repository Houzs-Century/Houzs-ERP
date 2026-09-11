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
  type SgAddress,
} from './sg-postcode-queries';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const addr = (o: Partial<SgAddress>): SgAddress => ({
  postcode: '', building: '', blockNo: '', road: '', address: '', lat: '', lng: '', ...o,
});

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
