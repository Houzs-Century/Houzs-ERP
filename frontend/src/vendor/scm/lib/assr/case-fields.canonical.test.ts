
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ASSR_ISSUE_CATEGORIES,
  ASSR_NOTE_AUDIENCES,
  assrNoteIsCustomerVisible,
} from './case-fields';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const DESKTOP = 'src/pages/ServiceCases.tsx';
const MOBILE = 'src/mobile/MobileServiceCase.tsx';
const SURFACES: Array<[string, string]> = [
  ['ServiceCases (desktop add-note form + create panel)', DESKTOP],
  ['MobileServiceCase (mobile note sheet + new-case sheet)', MOBILE],
];

describe('the note audience picker names the consequence, not the bucket', () => {
  test('the stored values are the four the server accepts', () => {
    expect(ASSR_NOTE_AUDIENCES.map((a) => a.value)).toEqual([
      'service',
      'customer',
      'supplier',
      'sales',
    ]);
  });

  test('every label states which side of the customer line it falls on', () => {
    for (const a of ASSR_NOTE_AUDIENCES) {
      const visible = assrNoteIsCustomerVisible(a.value);
      expect(
        visible ? a.label.includes('visible') : a.label.includes('internal'),
        `"${a.label}" leaves the reader to guess whether the customer sees it`,
      ).toBe(true);
    }
  });

  test('exactly one bucket is customer-visible', () => {
    expect(ASSR_NOTE_AUDIENCES.filter((a) => assrNoteIsCustomerVisible(a.value))).toHaveLength(1);
  });

  test('mobile no longer keeps its own NOTE_AUDIENCE_OPTIONS', () => {
    expect(
      code(MOBILE).includes('NOTE_AUDIENCE_OPTIONS'),
      'MobileServiceCase has re-grown its own audience list — the "Customer" / "Customer-visible" split came back',
    ).toBe(false);
  });

  for (const [name, path] of SURFACES) {
    test(`${name} reads the shared audience list`, () => {
      expect(
        code(path).includes('ASSR_NOTE_AUDIENCES'),
        `${name} no longer reads the shared audience list`,
      ).toBe(true);
    });

    test(`${name} spells no audience label of its own`, () => {
      const source = code(path);
      for (const a of ASSR_NOTE_AUDIENCES) {
        expect(
          source.includes(`>${a.label}<`) || source.includes(`"${a.label}"`),
          `${name} hand-types the audience label "${a.label}"`,
        ).toBe(false);
      }
    });

    test(`${name} renders the shared label, not one of its own`, () => {
      const source = code(path);
      let found = 0;
      for (
        let i = source.indexOf('ASSR_NOTE_AUDIENCES');
        i > -1;
        i = source.indexOf('ASSR_NOTE_AUDIENCES', i + 1)
      ) {
        if (!source.slice(i, i + 40).includes('.map(')) continue;
        found++;
        const block = source.slice(i, i + 600);
        expect(
          /\{\s*[ao]\.label\s*\}/.test(block),
          `${name} maps the shared list but prints something other than its label`,
        ).toBe(true);
      }
      expect(found, `${name} no longer renders the shared audience list`).toBeGreaterThan(0);
    });
  }
});

describe('the issue-category fallback has one home', () => {
  test('the five shipped categories are unchanged', () => {
    expect([...ASSR_ISSUE_CATEGORIES]).toEqual([
      'Product defect',
      'Incorrect item delivered',
      'Missing / short item',
      'Warranty / service request',
      'Installation / assembly issue',
    ]);
  });

  for (const [name, path] of SURFACES) {
    test(`${name} reads the shared category list`, () => {
      expect(
        code(path).includes('ASSR_ISSUE_CATEGORIES'),
        `${name} no longer reads the shared category list`,
      ).toBe(true);
    });

    test(`${name} spells no category of its own`, () => {
      const source = code(path);
      for (const cat of ASSR_ISSUE_CATEGORIES) {
        expect(
          source.includes(`"${cat}"`) || source.includes(`'${cat}'`),
          `${name} hand-types the issue category "${cat}"`,
        ).toBe(false);
      }
    });
  }
});
