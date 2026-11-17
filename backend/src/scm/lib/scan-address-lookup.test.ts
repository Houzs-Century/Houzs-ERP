import { describe, expect, it, vi } from 'vitest';
import { resolveSlipAddress, type AddressLookups, type GeocodedParts, type LocalityParts, type SlipAddressFields } from './scan-address-lookup';

const LOCALITIES: Record<string, LocalityParts> = {
  '09000': { city: 'Kulim', state: 'Kedah' },
  '50480': { city: 'Kuala Lumpur', state: 'Kuala Lumpur' },
  '14000': { city: 'Bukit Mertajam', state: 'Pulau Pinang' },
  '06600': { city: 'Kuala Kedah', state: 'Kedah' },
};

function slipWithAddress(address: string): SlipAddressFields {
  return { address, postcode: null, city: null, addressStateMatch: null };
}

function slipWith(postcode: string | null, city: string | null = null): SlipAddressFields {
  return { address: 'Bukit Tunku', postcode, city, addressStateMatch: null };
}

function lookupsReturning(geocoded: GeocodedParts | null): AddressLookups & { geocode: ReturnType<typeof vi.fn> } {
  return {
    findLocality: async (postcode: string) => LOCALITIES[postcode] ?? null,
    geocode: vi.fn(async () => geocoded),
  };
}

describe('resolveSlipAddress', () => {
  it('keepsAKnownWrittenPostcodeAndNeverCallsTheMapLookup', async () => {
    const slip = slipWith('09000');
    const lookups = lookupsReturning({ postcode: '50480', city: 'Kuala Lumpur', state: 'Kuala Lumpur' });

    await resolveSlipAddress(slip, lookups);

    expect(slip.postcode).toBe('09000');
    expect(slip.city).toBe('Kulim');
    expect(slip.addressStateMatch?.value).toBe('Kedah');
    expect(lookups.geocode).not.toHaveBeenCalled();
  });

  it('readsAWrittenPostcodeWithSpacesOrSymbols', async () => {
    const slip = slipWith('14 000');

    await resolveSlipAddress(slip, lookupsReturning(null));

    expect(slip.postcode).toBe('14000');
    expect(slip.city).toBe('Bukit Mertajam');
  });

  it('usesTheMapLookupWhenTheSlipHasNoPostcode', async () => {
    const slip = slipWith(null);
    const lookups = lookupsReturning({ postcode: '50480', city: 'KL', state: 'WP' });

    await resolveSlipAddress(slip, lookups);

    expect(lookups.geocode).toHaveBeenCalledOnce();
    expect(slip.postcode).toBe('50480');
    expect(slip.city).toBe('Kuala Lumpur');
    expect(slip.addressStateMatch?.value).toBe('Kuala Lumpur');
  });

  it('usesTheMapLookupWhenTheWrittenPostcodeIsNotInTheMaster', async () => {
    const slip = slipWith('99999');
    const lookups = lookupsReturning({ postcode: '09000', city: null, state: null });

    await resolveSlipAddress(slip, lookups);

    expect(slip.postcode).toBe('09000');
    expect(slip.city).toBe('Kulim');
  });

  it('keepsTheSlipAsReadWhenTheMapLookupFindsNothing', async () => {
    const slip = slipWith('123', 'Kapar');

    await resolveSlipAddress(slip, lookupsReturning(null));

    expect(slip.postcode).toBe('123');
    expect(slip.city).toBe('Kapar');
    expect(slip.addressStateMatch).toBeNull();
  });

  it('takesAKnownPostcodeWrittenInsideTheAddressWhenThePostcodeFieldIsEmpty', async () => {
    const slip = slipWithAddress('Nurul ikan bakar, jalan kuala kedah, kota star, 06600 keda');
    const lookups = lookupsReturning({ postcode: '50480', city: 'Kuala Lumpur', state: 'Kuala Lumpur' });

    await resolveSlipAddress(slip, lookups);

    expect(slip.postcode).toBe('06600');
    expect(slip.city).toBe('Kuala Kedah');
    expect(slip.addressStateMatch?.value).toBe('Kedah');
    expect(lookups.geocode).not.toHaveBeenCalled();
  });

  it('ignoresAFiveDigitLotNumberThatIsNotAPostcode', async () => {
    const slip = slipWithAddress('Lot 23961, Jalan Kuala Kedah 06600');

    await resolveSlipAddress(slip, lookupsReturning(null));

    expect(slip.postcode).toBe('06600');
  });

  it('usesTheMapLookupWhenTheAddressHoldsTwoKnownPostcodes', async () => {
    const slip = slipWithAddress('09000 Kulim or 14000 Bukit Mertajam');
    const lookups = lookupsReturning({ postcode: '14000', city: null, state: null });

    await resolveSlipAddress(slip, lookups);

    expect(lookups.geocode).toHaveBeenCalledOnce();
    expect(slip.postcode).toBe('14000');
  });

  it('doesNotSearchTheAddressWhenAWrittenPostcodeIsUnknown', async () => {
    const slip: SlipAddressFields = { address: 'Kulim 09000', postcode: '99999', city: null, addressStateMatch: null };
    const lookups = lookupsReturning(null);

    await resolveSlipAddress(slip, lookups);

    expect(lookups.geocode).toHaveBeenCalledOnce();
    expect(slip.postcode).toBe('99999');
  });

  it('usesGoogleCityAndStateWhenItsPostcodeIsNotInTheMaster', async () => {
    const slip = slipWith(null);

    await resolveSlipAddress(slip, lookupsReturning({ postcode: '77777', city: 'Klang', state: 'Selangor' }));

    expect(slip.postcode).toBe('77777');
    expect(slip.city).toBe('Klang');
    expect(slip.addressStateMatch?.value).toBe('Selangor');
  });
});
