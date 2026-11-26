import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  placeCandidates, soCandidates, dpPlace, assrPlace, projectPlace, parseJobRef, locateStops, unlocatedReason,
} from './stop-geo';
import { clearRememberedMisses, normalizeAddress, parseGeocode } from './geocode';

/* The Last Mile map pins EVERY stop of a lorry's day (owner 2026-11-18: "VNB9058
   has only ONE point"). These pin which address each job type is located by,
   and the postcode-area fallback. */

describe('placeCandidates — the address tried per job type', () => {
  it('a setup / dismantle venue with no street is tried by NAME + postcode city state, then the postcode area', () => {
    const c = placeCandidates(projectPlace({
      venue: 'MELAKA INTERNATIONAL TRADE CENTRE', name: '2026-11-MEGAHOME-MELAKA', venue_address: null, state: null,
      venue_postcode: '75450', venue_city: 'Ayer Keroh', venue_state: 'Melaka',
    }));
    expect(c).toEqual([
      { address: 'MELAKA INTERNATIONAL TRADE CENTRE, 75450 Ayer Keroh, Melaka, Malaysia', approximate: false },
      { address: '75450 Ayer Keroh, Melaka, Malaysia', approximate: true },
    ]);
  });

  it('a service-case leg uses its own lines + assr_case_address postcode / city / state, never the customer name', () => {
    const c = placeCandidates(assrPlace({
      addr1: '12 Jalan Teratai 3', addr2: 'Taman Teratai', addr3: null, addr4: null,
      case_postcode: '81300', case_city: 'Skudai', case_state: 'Johor', so_state: 'Selangor', so_postcode: '40000',
    }));
    expect(c[0]).toEqual({ address: '12 Jalan Teratai 3, Taman Teratai, 81300 Skudai, Johor, Malaysia', approximate: false });
    expect(c[c.length - 1]).toEqual({ address: '81300 Skudai, Johor, Malaysia', approximate: true });
    expect(c.some((g) => /zuhaib/i.test(g.address))).toBe(false);
  });

  it('an old service case with the postcode only in its lines still gets the postcode area', () => {
    const p = assrPlace({
      addr1: '1-G-9 Halaman Teratai', addr2: 'lebuh nipah 2', addr3: '11900 Bayan Lepas', addr4: null,
      case_postcode: null, case_city: null, case_state: null, so_state: null, so_postcode: null,
    });
    expect(p.postcode).toBe('11900');
    const c = placeCandidates(p);
    expect(c[0]!.address).toBe('1-G-9 Halaman Teratai, lebuh nipah 2, 11900 Bayan Lepas, Malaysia');
    expect(c.find((g) => g.approximate)?.address).toBe('11900, Malaysia');
  });

  it('a supplier pickup with a real street tries the street first, then name + street, then the area', () => {
    const c = placeCandidates(dpPlace({
      job_type: 'SUPPLIER_PICKUP', party_name: 'Dreamland Factory', address1: 'Lot 5, Jalan Perusahaan 2', address2: null,
      address3: null, address4: null, postcode: '43000', city: 'Kajang', state: 'Selangor',
    }));
    expect(c.map((g) => g.address)).toEqual([
      'Lot 5, Jalan Perusahaan 2, 43000 Kajang, Selangor, Malaysia',
      'Dreamland Factory, Lot 5, Jalan Perusahaan 2, 43000 Kajang, Selangor, Malaysia',
      '43000 Kajang, Selangor, Malaysia',
    ]);
  });

  it('a DP job to a customer (SERVICE) is never geocoded by the party name', () => {
    const c = placeCandidates(dpPlace({
      job_type: 'SERVICE', party_name: 'Tan Ah Kow', address1: 'Jalan Bunga', address2: null, address3: null, address4: null,
      postcode: '50000', city: 'Kuala Lumpur', state: 'Kuala Lumpur',
    }));
    expect(c.some((g) => g.address.includes('Tan Ah Kow'))).toBe(false);
    expect(c.map((g) => g.approximate)).toEqual([false, true]);
  });

  it('a stop with only a postcode is pinned at the postcode area, approximate', () => {
    expect(placeCandidates({ name: null, lines: [], postcode: '47500', city: 'Subang Jaya', state: 'Selangor', useName: false }))
      .toEqual([{ address: '47500 Subang Jaya, Selangor, Malaysia', approximate: true }]);
  });

  it('a state alone is too coarse: nothing to try', () => {
    expect(placeCandidates({ name: null, lines: [null, ''], postcode: null, city: null, state: 'Selangor', useName: false })).toEqual([]);
  });

  it('a postcode the street already names is not repeated', () => {
    const c = placeCandidates({ name: null, lines: ['8 Jalan SS15/4, 47500 Subang Jaya'], postcode: '47500', city: 'Subang Jaya', state: 'Selangor', useName: false });
    expect(c[0]!.address).toBe('8 Jalan SS15/4, 47500 Subang Jaya, Selangor, Malaysia');
  });
});

describe('soCandidates', () => {
  it('keeps the composed SO address first (cache parity), then the postcode area', () => {
    expect(soCandidates('12 Jalan A, 53100, Kuala Lumpur, Malaysia', '53100', 'Kuala Lumpur', 'Malaysia')).toEqual([
      { address: '12 Jalan A, 53100, Kuala Lumpur, Malaysia', approximate: false },
      { address: '53100, Kuala Lumpur, Malaysia', approximate: true },
    ]);
  });
  it('an SO with no address and no postcode has nothing to try', () => {
    expect(soCandidates('', null, 'Selangor', null)).toEqual([]);
  });
});

describe('parseJobRef — the board row keys', () => {
  it('reads each key the board mints, and rejects anything else', () => {
    expect(parseJobRef('ASSR/2610-054#delivery')).toEqual({ kind: 'assr', assrNo: 'ASSR/2610-054' });
    expect(parseJobRef('ASSR/2611-045#inspection')).toEqual({ kind: 'assr', assrNo: 'ASSR/2611-045' });
    expect(parseJobRef('DP:3f2a9c1e-1111-4222-8333-944455556666')).toEqual({ kind: 'dp', id: '3f2a9c1e-1111-4222-8333-944455556666' });
    expect(parseJobRef('PRJ:812#SETUP')).toEqual({ kind: 'project', id: 812 });
    expect(parseJobRef('HC-SO-010458')).toBeNull();
    expect(parseJobRef('DP:;drop table')).toBeNull();
  });
});

describe('parseGeocode — a country- or state-only answer is no pin', () => {
  it('rejects a whole-country result', () => {
    expect(parseGeocode({ status: 'OK', results: [{ types: ['country', 'political'], geometry: { location: { lat: 4.2, lng: 101.9 } } }] })).toBeNull();
  });
  it('keeps a postcode-area result', () => {
    expect(parseGeocode({ status: 'OK', results: [{ types: ['postal_code'], geometry: { location: { lat: 2.25, lng: 102.28 }, location_type: 'APPROXIMATE' } }] }))
      .toMatchObject({ lat: 2.25, lng: 102.28 });
  });
});

function fakeSb(cache: Partial<Record<string, { lat: number; lng: number }>>) {
  const reads: string[][] = [];
  const sb = {
    from: () => {
      const q: Record<string, unknown> = {};
      let eqKey: string | null = null;
      q.select = () => q;
      q.in = (_col: string, keys: string[]) => {
        reads.push(keys);
        return Promise.resolve({ data: keys.filter((k) => cache[k]).map((k) => ({ normalized_address: k, ...cache[k] })), error: null });
      };
      q.eq = (_col: string, k: string) => { eqKey = k; return q; };
      q.maybeSingle = () => Promise.resolve({ data: eqKey && cache[eqKey] ? cache[eqKey] : null, error: null });
      q.upsert = (row: { normalized_address: string; lat: number; lng: number }) => { cache[row.normalized_address] = { lat: row.lat, lng: row.lng }; return Promise.resolve({ error: null }); };
      return q;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sb: sb as any, reads };
}

describe('locateStops — cache-first, first hit wins, area fallback approximate', () => {
  beforeEach(() => clearRememberedMisses());
  afterEach(() => vi.unstubAllGlobals());

  it('a cached full address pins exactly, with no Google call', async () => {
    const full = 'MITC, 75450 Ayer Keroh, Melaka, Malaysia';
    const { sb } = fakeSb({ [normalizeAddress(full)]: { lat: 2.27, lng: 102.28 } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await locateStops(sb, { GOOGLE_MAPS_API_KEY: 'k' }, new Map([['PRJ:1#SETUP', [
      { address: full, approximate: false }, { address: '75450 Ayer Keroh, Melaka, Malaysia', approximate: true },
    ]]]));
    expect(out.get('PRJ:1#SETUP')).toMatchObject({ ok: true, lat: 2.27, approximate: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('when Google cannot place the address, the cached postcode area pins it, approximate; the miss is not re-billed', async () => {
    const area = '81300 Skudai, Johor, Malaysia';
    const { sb } = fakeSb({ [normalizeAddress(area)]: { lat: 1.53, lng: 103.66 } });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] })));
    vi.stubGlobal('fetch', fetchSpy);
    const cands = new Map([['ASSR/1#delivery', [{ address: 'nowhere lane 9', approximate: false }, { address: area, approximate: true }]]]);
    expect((await locateStops(sb, { GOOGLE_MAPS_API_KEY: 'k' }, cands)).get('ASSR/1#delivery')).toMatchObject({ ok: true, approximate: true, address: area });
    await locateStops(sb, { GOOGLE_MAPS_API_KEY: 'k' }, cands);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('two stops at one address cost one Google call, and the hit is cached', async () => {
    const { sb } = fakeSb({});
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ status: 'OK', results: [{ types: ['premise'], geometry: { location: { lat: 3.1, lng: 101.6 } } }] })));
    vi.stubGlobal('fetch', fetchSpy);
    const g = [{ address: '8 Jalan SS15/4, 47500 Subang Jaya, Selangor, Malaysia', approximate: false }];
    const out = await locateStops(sb, { GOOGLE_MAPS_API_KEY: 'k' }, new Map([['DP:aaaaaaaa-1', g], ['DP:aaaaaaaa-2', g]]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out.get('DP:aaaaaaaa-2')).toMatchObject({ ok: true, lat: 3.1 });
    await locateStops(sb, { GOOGLE_MAPS_API_KEY: 'k' }, new Map([['DP:aaaaaaaa-1', g]]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('nothing to try, or no key and no cache: unlocated with the reason', async () => {
    const { sb } = fakeSb({});
    const out = await locateStops(sb, {}, new Map([['A#delivery', []], ['B#delivery', [{ address: 'x 1', approximate: false }]]]));
    expect(out.get('A#delivery')).toEqual({ ok: false, reason: 'no address, postcode or city on file' });
    expect(out.get('B#delivery')).toEqual({ ok: false, reason: unlocatedReason([{ address: 'x 1', approximate: false }], false) });
  });

describe('Singapore addresses (HC-SO-011153, 2026-11-18)', () => {
  it('a Singapore order also tries its 6-digit postcode, which names the building', () => {
    expect(soCandidates('621 woodlans dr052 05-50, 730621, North, Singapore', '730621', 'North', 'Singapore')).toEqual([
      { address: '621 woodlans dr052 05-50, 730621, North, Singapore', approximate: false },
      { address: '730621, Singapore', approximate: false },
    ]);
  });
});
});
