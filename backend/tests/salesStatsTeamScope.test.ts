// ----------------------------------------------------------------------------
// /pos/sales-stats — the Team card (2990 ticket 2990-0045, 2026-11-09).
//
// A salesperson in "Kris Team" could see only her own sales and her showroom's.
// The team is the Team Directory's `users.division` (free text, within a
// department), NOT the manager_id tree and NOT the showroom: 5 of Kris Team's
// 9 members have no showroom. Every member sees the total, not only the leader.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import posSrc from '../src/routes/pos.ts?raw';
import { salesTeamKey } from '../src/routes/pos';

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

  test('no team => no team fields (absent, not 0), and no permission gate on it', () => {
    expect(POS).toMatch(/\.\.\.\(team && t \? \{/);
    expect(POS).not.toMatch(/canTargetSalesperson\([^)]*\)[\s\S]{0,80}teamWhere/);
  });
});
