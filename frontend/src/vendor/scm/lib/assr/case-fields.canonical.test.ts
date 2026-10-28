/* The ASSR case field vocabularies have ONE home — and the one that had
 * already drifted is the one a customer can read.
 *
 * THE BUG. `ServiceCases.tsx` (desktop) and `MobileServiceCase.tsx` (mobile)
 * each wrote out the note-audience picker and the issue-category fallback. The
 * audience LABELS had come apart: desktop offered "Customer-visible", mobile
 * offered "Customer". Same four stored values, two different promises to the
 * person typing — and the promise is the whole point of that control, because
 * `customer` is the only bucket the portal shows. A rep on the phone reading
 * "Customer" has been told which BUCKET the note goes in; a rep on the desktop
 * reading "Customer-visible" has been told what will HAPPEN. Only one of those
 * stops a private remark from reaching the customer.
 *
 * Issue categories were still identical on both surfaces the day this was
 * written. That is not a reason to leave them: it is what the audience labels
 * looked like the day BEFORE they drifted.
 *
 * ── WHY SOURCE-SCAN ─────────────────────────────────────────────────────────
 * Same reason as assr-stage-labels.canonical.test.ts, one directory up: these
 * two screens are 8,800 and 3,400 lines and cannot be imported without a
 * router, a query client and a jsdom tree. What must not come back is a screen
 * QUOTING the list instead of reading it, and that is what the source says.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ASSR_ISSUE_CATEGORIES,
  ASSR_NOTE_AUDIENCES,
  assrNoteIsCustomerVisible,
} from './case-fields';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

/** Comments stripped: a label QUOTED in an explanation is not a second copy of
 *  the rule, and these files explain themselves at length. */
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
    /* backend/src/routes/assr.ts NOTE_CATEGORIES coerces anything else to
       "service", so a typo here does not error — it silently files the note
       under the wrong audience. `system` is auto-emitted and correctly absent. */
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
      /* Scoped to the picker itself. A tree-wide scan for the bucket words was
         the first draft and it was WRONG in the direction that wastes a
         reader's afternoon: mobile's supplier CARD carries a `<span>Supplier
         </span>` field label that has nothing to do with note audiences, and
         the scan reported it as re-grown drift. Assert what the picker does. */
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
