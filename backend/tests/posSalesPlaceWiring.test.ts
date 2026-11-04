// ----------------------------------------------------------------------------
// The 2990 POS My-orders "showroom or roadshow event" pick — wired the same way
// into the two reads it narrows.
//
// The rule itself is pure and tested in scm/lib/pos-sales-place.test.ts. What
// can only break HERE is the wiring: the tiles narrowed while the board was
// not (or by another rule), so the board shows a different set of orders from
// the one the tiles above it count; or the picker's list read AFTER the pick
// narrowed it, so picking a place empties the list it was picked from.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import posSrc from '../src/routes/pos.ts?raw';
import { soRouterSource } from './lib/so-router-source';

/** Comments quote the shapes this file is about — strip them. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const POS = code(posSrc);
const statsBlock = (): string => {
  const start = POS.indexOf('pos.get("/sales-stats"');
  expect(start).toBeGreaterThan(-1);
  const next = POS.indexOf('pos.post(', start);
  return POS.slice(start, next === -1 ? undefined : next);
};

const routeSource = code(soRouterSource());
const mineBlock = (): string => {
  const start = routeSource.indexOf("mfgSalesOrders.get('/mine'");
  expect(start).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/mfgSalesOrders\.(get|post|patch|put|delete)\(/);
  return routeSource.slice(start, next === -1 ? undefined : start + 1 + next);
};

describe('/pos/sales-stats — the pick', () => {
  test('reads ?project= and ?venue= through the shared reader', () => {
    expect(statsBlock()).toMatch(/readSalesPlace\(c\.req\.query\("project"\), c\.req\.query\("venue"\)\)/);
  });

  test('lists the places BEFORE the pick narrows the tiles', () => {
    const block = statsBlock();
    const facet = block.indexOf('GROUP BY project_id');
    const narrow = block.indexOf('conds.push(placeClause.sql)');
    const tiles = block.indexOf('aggSql(showroomWhere)');
    expect(facet).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(facet);
    expect(tiles).toBeGreaterThan(narrow);
  });

  test('the list is read inside the Showroom card scope, with the company predicate', () => {
    expect(statsBlock()).toMatch(/\$\{\[\.\.\.conds, showroomWhere\]\.join\(" AND "\)\}/);
    expect(statsBlock()).toMatch(/activeCompanySql\(c, "p\.company_id"\)/);
  });

  test('answers with the pick and the list, also when there is nothing to count', () => {
    expect(statsBlock()).toMatch(/place, places: \[\] as SalesPlaceEntry\[\]/);
    expect(statsBlock()).toMatch(/place, places,\s*\}\);/);
  });
});

describe('/mine — the board narrows by the same pick', () => {
  test('reads the pick through the same reader', () => {
    expect(mineBlock()).toMatch(/readSalesPlace\(c\.req\.query\('project'\), c\.req\.query\('venue'\)\)/);
  });

  test('applies it with the period, not to a search — search stays a global lookup', () => {
    const block = mineBlock();
    const period = block.indexOf('rangeBoundsMy(fromYmd, toYmd)');
    const apply = block.indexOf('applySalesPlace(query, place)');
    const run = block.indexOf('await query');
    expect(period).toBeGreaterThan(block.indexOf('if (q) {'));
    expect(apply).toBeGreaterThan(period);
    expect(run).toBeGreaterThan(apply);
  });
});
