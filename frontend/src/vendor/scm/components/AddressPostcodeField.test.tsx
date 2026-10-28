import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useSgPostcodeLookup } = vi.hoisted(() => ({
  useSgPostcodeLookup: vi.fn(() => ({ data: undefined, isFetching: false })),
}));
vi.mock('../lib/sg-postcode-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/sg-postcode-queries')>()),
  useSgPostcodeLookup,
}));
// SgPostcodeField reads useLocalities to map the planning area back to a seeded
// { state, city }; stub it so the SG branch renders without a QueryClient.
const { useLocalities } = vi.hoisted(() => ({ useLocalities: vi.fn(() => ({ data: [] })) }));
vi.mock('../lib/localities-queries', () => ({ useLocalities }));

import { AddressPostcodeField } from './AddressPostcodeField';

afterEach(() => cleanup());

const base = {
  value: '',
  onChange: () => {},
  onCascadePick: () => {},
  onResolve: () => {},
  postcodeChoices: ['50000', '53300'],
  placeholder: 'Pick postcode',
};

describe('AddressPostcodeField', () => {
  it('uses the cascade dropdown (not the SG lookup) for a non-Singapore country', () => {
    render(<AddressPostcodeField country="Malaysia" {...base} />);
    expect(screen.queryByPlaceholderText(/6-digit SG postcode/)).toBeNull();
    expect(useSgPostcodeLookup).not.toHaveBeenCalled();
  });

  it('uses the live SG lookup for Singapore', () => {
    render(<AddressPostcodeField country="Singapore" {...base} />);
    expect(screen.getByPlaceholderText(/6-digit SG postcode/)).toBeTruthy();
  });
});
