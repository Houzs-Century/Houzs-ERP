import { describe, it, expect } from 'vitest';
import { normalizeAddress, composeAddress, buildGeocodeUrl, parseGeocode } from './geocode';

describe('normalizeAddress', () => {
  it('lower-cases, strips punctuation, collapses whitespace', () => {
    expect(normalizeAddress('12, Jalan A/1.')).toBe('12 jalan a 1');
    expect(normalizeAddress('  12   Jalan   A 1 ')).toBe('12 jalan a 1');
  });
  it('collapses trivial variants of the same address to one key', () => {
    expect(normalizeAddress('12, Jalan A/1.')).toBe(normalizeAddress('12 Jalan A 1'));
  });
  it('returns empty string for blank input', () => {
    expect(normalizeAddress('')).toBe('');
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress('   ')).toBe('');
  });
});

describe('composeAddress', () => {
  it('joins present parts with commas, skipping blanks', () => {
    expect(composeAddress({ address1: '12 Jalan A', address2: '', postcode: '53100', state: 'Kuala Lumpur' }))
      .toBe('12 Jalan A, 53100, Kuala Lumpur');
  });
  it('leaves no stray comma when a line is missing', () => {
    expect(composeAddress({ address1: '12 Jalan A', postcode: '53100' })).toBe('12 Jalan A, 53100');
  });
  it('is empty when nothing is present', () => {
    expect(composeAddress({})).toBe('');
  });
});

describe('buildGeocodeUrl', () => {
  it('URL-encodes the address and biases to Malaysia', () => {
    const url = buildGeocodeUrl('12 Jalan A, 53100', 'KEY123');
    expect(url).toContain('address=12%20Jalan%20A%2C%2053100');
    expect(url).toContain('region=my');
    expect(url).toContain('components=country:MY');
    expect(url).toContain('key=KEY123');
  });
});

describe('parseGeocode', () => {
  it('extracts lat/lng + formatted address + precision on OK', () => {
    const hit = parseGeocode({
      status: 'OK',
      results: [{
        formatted_address: '12, Jalan A, 53100 KL',
        geometry: { location: { lat: 3.21, lng: 101.7 }, location_type: 'ROOFTOP' },
      }],
    });
    expect(hit).toEqual({ lat: 3.21, lng: 101.7, formattedAddress: '12, Jalan A, 53100 KL', locationType: 'ROOFTOP' });
  });
  it('returns null on a non-OK status', () => {
    expect(parseGeocode({ status: 'ZERO_RESULTS', results: [] })).toBeNull();
  });
  it('returns null on the null island (0,0 with no location)', () => {
    expect(parseGeocode({ status: 'OK', results: [{ geometry: { location: { lat: 0, lng: 0 } } }] })).toBeNull();
  });
  it('returns null when lat/lng are missing', () => {
    expect(parseGeocode({ status: 'OK', results: [{ geometry: {} }] })).toBeNull();
  });
});
