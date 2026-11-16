export interface LocalityParts {
  city: string | null;
  state: string | null;
}

export interface GeocodedParts extends LocalityParts {
  postcode: string | null;
}

export interface SlipAddressFields {
  address: string | null;
  postcode: string | null;
  city: string | null;
  addressStateMatch: { value: string; confidence: number; reason: string } | null;
}

export interface AddressLookups {
  findLocality(postcode: string): Promise<LocalityParts | null>;
  geocode(address: string | null): Promise<GeocodedParts | null>;
}

const POSTCODE_ON_SLIP = 'postcode on slip';
const GOOGLE_GEOCODE = 'Google geocode';

function writtenPostcode(postcode: string | null): string | null {
  const digits = (postcode ?? '').replace(/[^\d]/g, '');
  return digits.length === 5 ? digits : null;
}

function applyLocality(slip: SlipAddressFields, locality: LocalityParts, reason: string): void {
  if (locality.city) slip.city = locality.city;
  if (locality.state) slip.addressStateMatch = { value: locality.state, confidence: 0.95, reason };
}

export async function resolveSlipAddress(slip: SlipAddressFields, lookups: AddressLookups): Promise<void> {
  const postcode = writtenPostcode(slip.postcode);
  const knownLocality = postcode ? await lookups.findLocality(postcode) : null;
  if (postcode && knownLocality) {
    slip.postcode = postcode;
    applyLocality(slip, knownLocality, POSTCODE_ON_SLIP);
    return;
  }

  const geocoded = await lookups.geocode(slip.address);
  if (!geocoded) return;
  let locality: LocalityParts = { city: geocoded.city, state: geocoded.state };
  if (geocoded.postcode) {
    slip.postcode = geocoded.postcode;
    locality = (await lookups.findLocality(geocoded.postcode)) ?? locality;
  }
  applyLocality(slip, locality, GOOGLE_GEOCODE);
}
