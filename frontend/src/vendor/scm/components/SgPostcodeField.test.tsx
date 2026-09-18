import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SgAddress } from '../lib/sg-postcode-queries';

const { useSgPostcodeLookup } = vi.hoisted(() => ({ useSgPostcodeLookup: vi.fn() }));
vi.mock('../lib/sg-postcode-queries', async (orig) => ({
  ...(await orig<typeof import('../lib/sg-postcode-queries')>()),
  useSgPostcodeLookup,
}));
// The field maps the planning area back to a seeded { state, city } via
// useLocalities; stub it so no QueryClient is needed and resolveSgPlanningArea
// (kept real by the mock above) runs against these rows.
const { useLocalities } = vi.hoisted(() => ({ useLocalities: vi.fn() }));
vi.mock('../lib/localities-queries', () => ({ useLocalities }));

import { SgPostcodeField } from './SgPostcodeField';

const addr = (o: Partial<SgAddress>): SgAddress => ({
  postcode: '', building: '', blockNo: '', road: '', address: '', lat: '', lng: '', planningArea: '', ...o,
});

beforeEach(() => {
  useSgPostcodeLookup.mockReset();
  useLocalities.mockReset();
  useLocalities.mockReturnValue({ data: [] });
});
afterEach(() => cleanup());

describe('SgPostcodeField', () => {
  it('offers the address, with null state/city when the planning area is unresolved', () => {
    useSgPostcodeLookup.mockReturnValue({
      data: { configured: true, results: [addr({ postcode: '238801', address: '2 ORCHARD TURN ION ORCHARD SINGAPORE 238801' })] },
      isFetching: false,
    });
    const onResolve = vi.fn();
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolve={onResolve} />);
    fireEvent.click(screen.getByText(/^Use:/));
    expect(onResolve).toHaveBeenCalledWith({ address: '2 ORCHARD TURN ION ORCHARD SINGAPORE 238801', state: null, city: null });
  });

  it('also fills City + State when the planning area maps to a seeded SG row', () => {
    useLocalities.mockReturnValue({ data: [{ country: 'Singapore', city: 'Orchard', state: 'Central' }] });
    useSgPostcodeLookup.mockReturnValue({
      data: { configured: true, results: [addr({ postcode: '238801', address: '2 ORCHARD TURN', planningArea: 'ORCHARD' })] },
      isFetching: false,
    });
    const onResolve = vi.fn();
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolve={onResolve} />);
    // the offer names the area it will fill, so the operator sees it before tapping
    expect(screen.getByText(/Orchard, Central/)).toBeTruthy();
    fireEvent.click(screen.getByText(/^Use:/));
    expect(onResolve).toHaveBeenCalledWith({ address: '2 ORCHARD TURN', state: 'Central', city: 'Orchard' });
  });

  it('degrades with a hint when the lookup is not configured', () => {
    useSgPostcodeLookup.mockReturnValue({ data: { configured: false, results: [] }, isFetching: false });
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolve={() => {}} />);
    expect(screen.getByText(/Live lookup not enabled/)).toBeTruthy();
  });

  it('keeps only up to six digits of typed input', () => {
    useSgPostcodeLookup.mockReturnValue({ data: undefined, isFetching: false });
    const onChange = vi.fn();
    render(<SgPostcodeField value="" onChange={onChange} onResolve={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/6-digit/), { target: { value: 'a1b2c3d4e5f6g7' } });
    expect(onChange).toHaveBeenCalledWith('123456');
  });

  it('is inert when disabled — input disabled, no lookup offer', () => {
    useSgPostcodeLookup.mockReturnValue({
      data: { configured: true, results: [addr({ address: '2 ORCHARD TURN' })] },
      isFetching: false,
    });
    render(<SgPostcodeField value="238801" onChange={() => {}} onResolve={() => {}} disabled />);
    expect((screen.getByPlaceholderText(/6-digit/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText(/^Use:/)).toBeNull();
  });

  it('bare mode renders just the input, without its own Postcode label', () => {
    useSgPostcodeLookup.mockReturnValue({ data: undefined, isFetching: false });
    render(<SgPostcodeField bare value="" onChange={() => {}} onResolve={() => {}} />);
    expect(screen.getByPlaceholderText(/6-digit/)).toBeTruthy();
    expect(screen.queryByText('Postcode')).toBeNull();
  });
});
