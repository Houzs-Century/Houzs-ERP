import { describe, expect, it } from 'vitest';
import { PROJECT_VENUE_COLS, PROJECT_VENUE_JOIN, projectBoardAddress } from './project-venue-join';

/* Owner 2026-11-17: a project's SETUP / DISMANTLE job carries Postcode + City +
   State from the venue master the project picked. A project names its venue by
   text, so the join is the whole link — these pin what keeps it to ONE row of
   the RIGHT company. */
describe('PROJECT_VENUE_JOIN', () => {
  it('matches within the project company, by trimmed lower-cased name', () => {
    expect(PROJECT_VENUE_JOIN).toContain('v.company_id = p.company_id');
    expect(PROJECT_VENUE_JOIN).toContain('lower(trim(v.name)) = lower(trim(p.venue))');
  });
  it('picks exactly one venue row, active first, so a project never doubles', () => {
    expect(PROJECT_VENUE_JOIN).toMatch(/ORDER BY v\.active DESC, v\.id\s+LIMIT 1/);
  });
  it('exposes the three columns the board and the snapshot read', () => {
    expect(PROJECT_VENUE_COLS).toBe('pv.postcode AS venue_postcode, pv.city AS venue_city, pv.state AS venue_state');
  });
});

describe('projectBoardAddress', () => {
  it('appends the venue city and postcode to the venue line', () => {
    expect(projectBoardAddress('Sunway Pyramid Convention Centre', 'Subang Jaya', '47500'))
      .toBe('Sunway Pyramid Convention Centre, Subang Jaya, 47500');
  });
  it('does not repeat what the line already says', () => {
    expect(projectBoardAddress('Hall 3, 47500 Subang Jaya', 'Subang Jaya', '47500')).toBe('Hall 3, 47500 Subang Jaya');
  });
  it('is the venue line alone when the venue has no postcode yet, and null for nothing', () => {
    expect(projectBoardAddress('MITEC', null, null)).toBe('MITEC');
    expect(projectBoardAddress(null, null, null)).toBeNull();
    expect(projectBoardAddress(null, 'Kuala Lumpur', '50480')).toBe('Kuala Lumpur, 50480');
  });
});
