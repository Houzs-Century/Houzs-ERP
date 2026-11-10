// ----------------------------------------------------------------------------
// /pos/sales-stats — the Team card (2990 ticket 2990-0045, 2026-11-09).
//
// A salesperson in "Kris Team" could see only her own sales and her showroom's.
// The team is the Team Directory's `users.division` (free text, within a
// department), NOT the manager_id tree and NOT the showroom: 5 of Kris Team's
// 9 members have no showroom. Only a Title with the "See team sales" capability
// gets it (Lim, 10 Nov: Sales Director only).
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import posSrc from '../src/routes/pos.ts?raw';
import { salesTeamKey, TEAM_TOTAL_CAPABILITY } from '../src/routes/pos';
import { hasPositionCapability, isValidPositionCapability } from '../src/services/positionCapabilities';

const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const POS = code(posSrc);

describe('sales-stats — Team card', () => {
  test('the team key is the division, trimmed and case-folded', () => {
    expect(salesTeamKey('Kris Team')).toEqual({ name: 'Kris Team', key: 'kris team' });
    expect(salesTeamKey('  KRIS team ')).toEqual({ name: 'KRIS team', key: 'kris team' });
    expect(salesTeamKey('')).toBeNull();
    expect(salesTeamKey('   ')).toBeNull();
    expect(salesTeamKey(null)).toBeNull();
    expect(salesTeamKey(undefined)).toBeNull();
  });

  test('members are matched on department + division, not showroom or manager', () => {
    expect(POS).toMatch(/u\.department_id = \? AND lower\(btrim\(u\.division\)\) = \?/);
  });

  test('the team figures go through the same aggregate and KPI pass as the other cards', () => {
    expect(POS).toMatch(/aggSql\(teamWhere\)/);
    expect(POS).toMatch(/docSql\(teamWhere\)/);
    expect(POS).toMatch(/\.\.\.personalDocNos, \.\.\.teamDocNos/);
  });

  test('no team => no team fields (absent, not 0)', () => {
    expect(POS).toMatch(/\.\.\.\(team && t \? \{/);
  });
});

/* Lim, Hub 2990-0045 internal notes (10 Nov 2026): sales may not see what they
   could not see before without approval; it must be a permission. It is a
   per-Title capability on Roles & Permissions, OFF unless ticked. */
describe('sales-stats — Team card needs the "See team sales" capability', () => {
  test('the key is in the catalogue, so the matrix can tick it', () => {
    expect(TEAM_TOTAL_CAPABILITY).toBe('pos.sales.teamTotal');
    expect(isValidPositionCapability(TEAM_TOTAL_CAPABILITY)).toBe(true);
  });

  test('a Title without the tick is denied; with it, or `*`, allowed', () => {
    const exec = { permissions_set: new Set<string>(), position_capabilities: [] };
    const director = { permissions_set: new Set<string>(), position_capabilities: [TEAM_TOTAL_CAPABILITY] };
    const owner = { permissions_set: new Set(['*']), position_capabilities: [] };
    expect(hasPositionCapability(exec, TEAM_TOTAL_CAPABILITY)).toBe(false);
    expect(hasPositionCapability(director, TEAM_TOTAL_CAPABILITY)).toBe(true);
    expect(hasPositionCapability(owner, TEAM_TOTAL_CAPABILITY)).toBe(true);
  });

  test('the route checks the capability before it resolves a team', () => {
    expect(POS).toMatch(/hasPositionCapability\([\s\S]{0,120}TEAM_TOTAL_CAPABILITY,?\s*\)/);
    expect(POS).toMatch(/const team = mayTeam && /);
  });
});
