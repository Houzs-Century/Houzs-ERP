import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useSgPostcodeLookup } = vi.hoisted(() => ({
  useSgPostcodeLookup: vi.fn(() => ({ data: undefined, isFetching: false })),
}));
vi.mock('../lib/sg-postcode-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/sg-postcode-queries')>()),
  useSgPostcodeLookup,
}));

import { AddressPostcodeField } from './AddressPostcodeField';

afterEach(() => cleanup());

const base = {
  value: '',
  onChange: () => {},
  onCascadePick: () => {},
  onResolveAddress: () => {},
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
