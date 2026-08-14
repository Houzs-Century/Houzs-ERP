// The four master-data maps are GENERATED now. This is the proof that moving
// them out of TypeScript changed nothing, and the ratchet that keeps it true.
//
// WHY A FROZEN BASELINE. On 2026-08-14 the maps stopped being hand-written
// object literals in autocount-writeback.ts and became a generated file
// compiled from scripts/data/autocount-so-writeback-mappings.json. A refactor
// of a map that decides which SALESPERSON and which STOCK LOCATION reach a
// licensed account book has to be shown behaviour-preserving, not argued to be
// — so every pair the composer carried on that date is pinned below, read out
// of the running module the composer itself imports.
//
// IT IS A RATCHET, NOT A SNAPSHOT. Adding a binding is the whole point of the
// exercise and must stay free; REMOVING one, or quietly re-pointing `KAR JIUN`
// at a different agent, is a silent change to what lands in the book. So the
// assertion is superset-and-unchanged, and a confirmed proposal never touches
// this file.
import { describe, expect, it } from 'vitest';
import {
  AGENT_MAP,
  LOCATION_MAP,
  VENUE_MAP,
  BRANDING_MAP,
} from '../src/services/autocount-writeback';

/** Every pair the composer carried at HEAD on 2026-08-14, `KEY=VALUE`. */
const BASELINE_2026_08_14: Record<string, string[]> = {
  AGENT_MAP: [
    'ANTHONY=ANTHONY', 'YUNY=YUNY', 'KRIS=KRIS', 'SHAWN=SHAWN', 'LAWRENCE=LAWRENCE',
    'KINGSLEY=KINGSLEY', 'STANLEY=STANLEY', 'JUNIE=JUNIE', 'MEI TING=MEI TING',
    'PETER=PETER', 'WEI HOW=WEI HOW', 'RACHAEL=RACHAEL', 'SALLY=SALLY', 'ZACK=Zack',
    'SHELDON TAN=SHELDON', 'JAMES SEOW=JAMES SEOW', 'LUCAS=LUCAS', 'ADRIAN=ADRIAN',
    'ESTHER CHONG=ESTHER CHONG', 'MELVIN CHONG=MELVIN CHONG', 'CHEA HUAN=Chea Huan',
    'WENGGI=WENGGI', 'KAR JIUN=TAN KAR JIUN', 'HWA SHENG=Hwasheng',
    'SHI TING=Chang Shi Ting', 'LUIS TEO=LUIS', 'PEI FEN=PEIFEN',
    'LIM YAU WEI=LIM YAU WEI', 'ETHAN=ETHAN SOO', 'WEI PIN=WEIPIN',
  ],
  LOCATION_MAP: [
    'KL WAREHOUSE=KL', 'PG WAREHOUSE=PG', 'SLGR WAREHOUSE=KL', 'KUALA LUMPUR=KL',
    'PETALING JAYA=KL', 'CHERAS=KL', 'SHAH ALAM=KL', 'GEORGE TOWN=PG',
    'KOTA KINABALU=SBH', 'KUANTAN=KL', 'JOHOR BAHRU=KL',
    'KL=KL', 'PG=PG', 'SRW=SRW', 'SBH=SBH', 'HQ=HQ',
  ],
  VENUE_MAP: [
    'SUNWAY PYRAMID CONVENTION CENTRE=SUNWAY PYRAMID CONVENTION CENTRE',
    'SUTERA MALL=SUTERA MALL SOLO',
    'KLCC CONVENTION CENTRE=KUALA LUMPUR CONVENTION CENTRE',
    'SUTERA SQUARE=SUTRA SQUARE JOHOR',
    'MVEC SOUTHKEY=MIDVALLEY SOUTHKEY JB',
    'SUNWAY KLUANG MALL=SUNWAY KLUANG MALL SOLO',
    'KSL CITY MALL=KSL CITY MALL JOHOR SOLO',
  ],
  BRANDING_MAP: [
    'AKEMI=AKEMI', 'DUNLOPILLO=DUNLOPILLO', 'ERGOTEX=ERGOTEX', 'MYLATEX=MYLATEX',
    'HOUZS=HOUZS', 'ZANOTTI=ZANOTTI', 'NONE=NONE', 'CARRESS=CARRESS', 'DUNLOP=DUNLOP',
  ],
};

const LIVE: Record<string, Record<string, string>> = {
  AGENT_MAP, LOCATION_MAP, VENUE_MAP, BRANDING_MAP,
};

describe('the generated master maps', () => {
  it.each(Object.keys(BASELINE_2026_08_14))('%s still carries every 2026-08-14 pair, unchanged', (name) => {
    const live = LIVE[name];
    for (const pair of BASELINE_2026_08_14[name]) {
      const at = pair.indexOf('=');
      const [key, value] = [pair.slice(0, at), pair.slice(at + 1)];
      expect(`${key}=${live[key]}`).toBe(pair);
    }
  });

  it('looks every key up the way bookSpelling does — uppercase, single-spaced', () => {
    /* A key in any other shape is unreachable BY KEY: `bookSpelling` normalises
       the input and indexes with it, so `"Shi Ting"` matched nothing while
       `"SHI TING"` matches. The generator normalises; this is what proves it
       did, on the object the composer actually uses. */
    for (const [name, map] of Object.entries(LIVE)) {
      for (const key of Object.keys(map)) {
        expect(`${name}: ${key}`).toBe(`${name}: ${key.toUpperCase().replace(/\s+/g, ' ').trim()}`);
      }
    }
  });

  it('never maps a value to nothing', () => {
    for (const map of Object.values(LIVE)) {
      for (const value of Object.values(map)) expect(value.trim()).not.toBe('');
    }
  });
});
