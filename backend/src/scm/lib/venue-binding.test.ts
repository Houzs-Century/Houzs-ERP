import { describe, it, expect } from 'vitest';
import {
  resolveVenueBinding,
  canAutoResolveVenue,
  type PmsCandidate,
  type ShowroomCandidate, venueNameForHalfWrittenPair } from './venue-binding';
import { todayMyt } from './my-time';


const project = (o: Partial<PmsCandidate> & { projectId: number }): PmsCandidate => ({
  projectName: `Project ${o.projectId}`,
  venue: 'MITEC Hall 5',
  startDate: '2026-07-01',
  endDate: '2026-07-31',
  ...o,
});

const showroom = (o: Partial<ShowroomCandidate> = {}): ShowroomCandidate => ({
  warehouseId: 'wh-uuid-1',
  warehouseName: 'KL-SHOWROOM',
  venueName: 'Kuala Lumpur Showroom',
  ...o,
});

describe('resolveVenueBinding — the owner\'s resolution order', () => {
  it('1. PMS wins over showroom when the rep is on an in-period project', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 7, venue: 'MITEC Hall 5' })],
      showroom: showroom(),
    });
    expect(r.source).toBe('PMS');
    expect(r.venueName).toBe('MITEC Hall 5');
    expect(r.projectId).toBe(7);
    expect(r.showroomWarehouseId).toBeNull();
  });

  it('2. the showroom is used when no PMS assignment applies', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [],
      showroom: showroom(),
    });
    expect(r.source).toBe('SHOWROOM');
    expect(r.venueName).toBe('Kuala Lumpur Showroom');
    expect(r.projectId).toBeNull();
    expect(r.showroomWarehouseId).toBe('wh-uuid-1');
  });

  it('2b. ZERO project assignments anywhere is the NORMAL steady state, not a degraded one', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [],
      showroom: showroom(),
    });
    expect(r).toEqual({
      venueName: 'Kuala Lumpur Showroom',
      projectId: null,
      projectName: null,
      source: 'SHOWROOM',
      showroomWarehouseId: 'wh-uuid-1',
    });
  });

  it('3. nothing resolves to EMPTY — never a guess', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [],
      showroom: null,
    });
    expect(r.venueName).toBeNull();
    expect(r.source).toBeNull();
    expect(r.projectId).toBeNull();
    expect(r.venueName).not.toBe('');
  });

  it('3b. a showroom with no venue_name resolves to nothing, NOT to its warehouse name', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [],
      showroom: showroom({ venueName: null }),
    });
    expect(r.venueName).toBeNull();
    expect(r.source).toBeNull();
    expect(r.venueName).not.toBe('KL-SHOWROOM');
  });

  it('3c. a blank/whitespace venue_name is absence, not a value', () => {
    expect(
      resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: [], showroom: showroom({ venueName: '   ' }) })
        .venueName,
    ).toBeNull();
  });

  it('falls THROUGH to the showroom when the only project has a blank venue', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 7, venue: '  ' })],
      showroom: showroom(),
    });
    expect(r.source).toBe('SHOWROOM');
  });
});

describe('resolveVenueBinding — the project PERIOD, by the ORDER\'s date', () => {
  it('resolves a BACKDATED order against the fair running on the order\'s date', () => {
    const june = project({ projectId: 1, venue: 'June Fair', startDate: '2026-06-01', endDate: '2026-06-30' });
    const july = project({ projectId: 2, venue: 'July Fair', startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(resolveVenueBinding({ soDate: '2026-06-15', pmsCandidates: [june, july], showroom: null }).venueName)
      .toBe('June Fair');
    expect(resolveVenueBinding({ soDate: '2026-07-15', pmsCandidates: [june, july], showroom: null }).venueName)
      .toBe('July Fair');
  });

  it('an ENDED project no longer claims orders — it falls back to the showroom', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 1, venue: 'March Fair', startDate: '2026-03-01', endDate: '2026-03-05' })],
      showroom: showroom(),
    });
    expect(r.source).toBe('SHOWROOM');
    expect(r.venueName).toBe('Kuala Lumpur Showroom');
  });

  it('a project that has not started yet does not claim orders', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 1, startDate: '2026-08-01', endDate: '2026-08-05' })],
      showroom: showroom(),
    });
    expect(r.source).toBe('SHOWROOM');
  });

  it('both period edges are INCLUSIVE — the first and last day of a fair are trading days', () => {
    const p = [project({ projectId: 1, venue: 'Edge Fair', startDate: '2026-07-10', endDate: '2026-07-12' })];
    expect(resolveVenueBinding({ soDate: '2026-07-10', pmsCandidates: p, showroom: null }).venueName).toBe('Edge Fair');
    expect(resolveVenueBinding({ soDate: '2026-07-12', pmsCandidates: p, showroom: null }).venueName).toBe('Edge Fair');
    expect(resolveVenueBinding({ soDate: '2026-07-09', pmsCandidates: p, showroom: null }).venueName).toBeNull();
    expect(resolveVenueBinding({ soDate: '2026-07-13', pmsCandidates: p, showroom: null }).venueName).toBeNull();
  });

  it('an open-ended project (no end_date) is still running', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 1, venue: 'Ongoing', startDate: '2026-01-01', endDate: null })],
      showroom: showroom(),
    });
    expect(r.venueName).toBe('Ongoing');
  });

  it('an UNDATED project (no start_date) has no period and claims nothing', () => {
    const r = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 1, venue: 'Undated', startDate: null, endDate: null })],
      showroom: showroom(),
    });
    expect(r.source).toBe('SHOWROOM');
  });

  it('an empty soDate resolves to nothing rather than guessing today', () => {
    expect(resolveVenueBinding({ soDate: '', pmsCandidates: [project({ projectId: 1 })], showroom: showroom() }))
      .toEqual({ venueName: null, projectId: null, projectName: null, source: null, showroomWarehouseId: null });
  });
});

describe('resolveVenueBinding — MYT midnight boundary', () => {
  const at = (iso: string) => {
    const realNow = Date.now;
    try {
      Date.now = () => new Date(iso).getTime();
      return todayMyt();
    } finally {
      Date.now = realNow;
    }
  };

  it('todayMyt rolls at 16:00Z, which is MYT midnight', () => {
    expect(at('2026-07-19T15:59:59Z')).toBe('2026-07-19');
    expect(at('2026-07-19T16:00:00Z')).toBe('2026-07-20');
  });

  it('an order placed just after MYT midnight belongs to the NEW day\'s fair', () => {
    const dayOne = project({ projectId: 1, venue: 'Day One Fair', startDate: '2026-07-19', endDate: '2026-07-19' });
    const dayTwo = project({ projectId: 2, venue: 'Day Two Fair', startDate: '2026-07-20', endDate: '2026-07-20' });
    const candidates = [dayOne, dayTwo];
    expect(resolveVenueBinding({ soDate: at('2026-07-19T15:59:59Z'), pmsCandidates: candidates, showroom: null }).venueName)
      .toBe('Day One Fair');
    expect(resolveVenueBinding({ soDate: at('2026-07-19T16:00:00Z'), pmsCandidates: candidates, showroom: null }).venueName)
      .toBe('Day Two Fair');
  });
});

describe('resolveVenueBinding — overlapping projects tie-break (deterministic)', () => {
  it('the LATEST start wins among overlapping periods', () => {
    const campaign = project({ projectId: 1, venue: 'Regional Campaign', startDate: '2026-05-01', endDate: '2026-09-30' });
    const fair = project({ projectId: 2, venue: 'MITEC Fair', startDate: '2026-07-18', endDate: '2026-07-21' });
    expect(resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: [campaign, fair], showroom: null }).venueName)
      .toBe('MITEC Fair');
  });

  it('same start: the SHORTEST period wins (specificity)', () => {
    const long = project({ projectId: 1, venue: 'Long', startDate: '2026-07-01', endDate: '2026-09-30' });
    const short = project({ projectId: 2, venue: 'Short', startDate: '2026-07-01', endDate: '2026-07-20' });
    expect(resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: [long, short], showroom: null }).venueName)
      .toBe('Short');
  });

  it('same start: a BOUNDED project beats an open-ended one', () => {
    const open = project({ projectId: 1, venue: 'Open', startDate: '2026-07-01', endDate: null });
    const bounded = project({ projectId: 2, venue: 'Bounded', startDate: '2026-07-01', endDate: '2026-12-31' });
    expect(resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: [open, bounded], showroom: null }).venueName)
      .toBe('Bounded');
  });

  it('identical periods: the LOWEST id wins, and the answer is STABLE under input order', () => {
    const a = project({ projectId: 4, venue: 'Alpha', startDate: '2026-07-01', endDate: '2026-07-31' });
    const b = project({ projectId: 9, venue: 'Beta', startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: [a, b], showroom: null }).venueName).toBe('Alpha');
    expect(resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: [b, a], showroom: null }).venueName).toBe('Alpha');
  });

  it('does not mutate the caller\'s candidate array', () => {
    const list = [project({ projectId: 9 }), project({ projectId: 4 })];
    resolveVenueBinding({ soDate: '2026-07-19', pmsCandidates: list, showroom: null });
    expect(list.map((p) => p.projectId)).toEqual([9, 4]);
  });
});

describe('canAutoResolveVenue — a human\'s pick survives a re-resolve', () => {
  it('refuses to overwrite a MANUAL venue', () => {
    expect(canAutoResolveVenue('MANUAL')).toBe(false);
  });

  it('allows re-resolving a venue the resolver itself put there', () => {
    expect(canAutoResolveVenue('PMS')).toBe(true);
    expect(canAutoResolveVenue('SHOWROOM')).toBe(true);
  });

  it('treats an unknown/legacy source as eligible, NOT as a human choice', () => {
    expect(canAutoResolveVenue(null)).toBe(true);
    expect(canAutoResolveVenue(undefined)).toBe(true);
  });

  it('the override is what the SO edit path must persist: MANUAL beats any resolution', () => {
    const resolved = resolveVenueBinding({
      soDate: '2026-07-19',
      pmsCandidates: [project({ projectId: 7, venue: 'MITEC Hall 5' })],
      showroom: showroom(),
    });
    expect(resolved.venueName).toBe('MITEC Hall 5');
    const persisted = { venue: 'Setia SPICE Arena', venue_source: 'MANUAL' };
    const nextVenue = canAutoResolveVenue(persisted.venue_source)
      ? resolved.venueName
      : persisted.venue;
    expect(nextVenue).toBe('Setia SPICE Arena');
  });
});

/* A HALF-WRITTEN PAIR IS NOT A CLEAR — and "could not tell" is its own answer.
 *
 * A client that resolved the venue id and not the name sends `venue: ''` beside
 * a real `venueId`. Read literally that is "clear the venue", and it wiped a
 * live order's venue for good (docs/bugs/0591-*). The third case is the one that
 * needs a test of its own: when the venue master cannot be READ, the answer must
 * not collapse onto the same blank, or a database blip deletes the venue off
 * whatever is being saved at that moment.
 */
describe('venueNameForHalfWrittenPair', () => {
  const reader = (result: { data: unknown; error: unknown }) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) }),
  });

  it('resolves the name when the id names a venue', async () => {
    const r = await venueNameForHalfWrittenPair(
      reader({ data: { name: 'PJ SHOWROOM' }, error: null }), '', 'v-1');
    expect(r).toEqual({ kind: 'resolved', name: 'PJ SHOWROOM' });
  });

  it('stands aside when BOTH are empty — that is a real clear, and it is allowed', async () => {
    const r = await venueNameForHalfWrittenPair(
      reader({ data: null, error: null }), '', '');
    expect(r.kind).toBe('notApplicable');
  });

  it('stands aside when the name is present — nothing to imply', async () => {
    const r = await venueNameForHalfWrittenPair(
      reader({ data: null, error: null }), '2990s PJ', 'v-1');
    expect(r.kind).toBe('notApplicable');
  });

  it('says UNRESOLVED when the read FAILS, never "no name"', async () => {
    const r = await venueNameForHalfWrittenPair(
      reader({ data: null, error: { message: 'connection reset' } }), '', 'v-1');
    expect(r.kind).toBe('unresolved');
  });

  it('says UNRESOLVED when the id matches no venue', async () => {
    const r = await venueNameForHalfWrittenPair(
      reader({ data: null, error: null }), '', 'v-missing');
    expect(r.kind).toBe('unresolved');
  });
});
