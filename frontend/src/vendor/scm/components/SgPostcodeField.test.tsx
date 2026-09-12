import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SgAddress } from '../lib/sg-postcode-queries';

const { useSgPostcodeLookup } = vi.hoisted(() => ({ useSgPostcodeLookup: vi.fn() }));
vi.mock('../lib/sg-postcode-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/sg-postcode-queries')>()),
  useSgPostcodeLookup,
}));

import { SgPostcodeField } from './SgPostcodeField';

const addr = (o: Partial<SgAddress>): SgAddress => ({
  postcode: '', building: '', blockNo: '', road: '', address: '', lat: '', lng: '', ...o,
});

beforeEach(() => useSgPostcodeLookup.mockReset());
afterEach(() => cleanup());

describe('SgPostcodeField', () => {
  it('offers the resolved address for one-tap fill', () => {
    useSgPostcodeLookup.mockReturnValue({
      data: { configured: true, results: [addr({ postcode: '238801', address: '2 ORCHARD TURN ION ORCHARD SINGAPORE 238801' })] },
      isFetching: false,
    });
    const onResolve = vi.fn();
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolveAddress={onResolve} />);
    fireEvent.click(screen.getByText(/^Use:/));
    expect(onResolve).toHaveBeenCalledWith('2 ORCHARD TURN ION ORCHARD SINGAPORE 238801');
  });

  it('degrades with a hint when the lookup is not configured', () => {
    useSgPostcodeLookup.mockReturnValue({ data: { configured: false, results: [] }, isFetching: false });
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolveAddress={() => {}} />);
    expect(screen.getByText(/Live lookup not enabled/)).toBeTruthy();
  });

  it('keeps only up to six digits of typed input', () => {
    useSgPostcodeLookup.mockReturnValue({ data: undefined, isFetching: false });
    const onChange = vi.fn();
    render(<SgPostcodeField value="" onChange={onChange} onResolveAddress={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/6-digit/), { target: { value: 'a1b2c3d4e5f6g7' } });
    expect(onChange).toHaveBeenCalledWith('123456');
  });

  it('is inert when disabled — input disabled, no lookup offer', () => {
    useSgPostcodeLookup.mockReturnValue({
      data: { configured: true, results: [addr({ address: '2 ORCHARD TURN' })] },
      isFetching: false,
    });
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolveAddress={() => {}} disabled />);
    expect((screen.getByPlaceholderText(/6-digit/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText(/^Use:/)).toBeNull();
  });

  it('bare mode renders just the input, without its own Postcode label', () => {
    useSgPostcodeLookup.mockReturnValue({ data: undefined, isFetching: false });
    render(<SgPostcodeField bare value="" onChange={() => {}} onResolveAddress={() => {}} />);
    expect(screen.getByPlaceholderText(/6-digit/)).toBeTruthy();
    expect(screen.queryByText('Postcode')).toBeNull();
  });
});
