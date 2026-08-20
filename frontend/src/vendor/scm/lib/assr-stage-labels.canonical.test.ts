/* The frontend half of the ASSR stage vocabulary.
 *
 * THE BUG. One stage — `voided` — had three different answers across five
 * hand-written copies of this table, and the copy a CUSTOMER reads
 * (backend caseTracking.ts `customerStatusFor`) had no answer at all and
 * rendered the raw database slug. On this side the shape was: the ordered
 * stepper `ASSR_STAGES` legitimately has no row for `voided` (it is a terminal
 * alt-outcome, not a funnel step) but it also owned the WORDS, so every surface
 * that needed a word for a non-step had to invent one. Mobile bolted a literal
 * on top of the stepper; the desktop Cases page spelled the same string in
 * three more places; MyCases and the supplier portal each kept a fourth and
 * fifth copy.
 *
 * Two questions had been fused into one table. They are separate now:
 * ASSR_STAGES answers ORDER, assr-stage-labels answers WORDS.
 *
 * ── WHY SOURCE-SLICE ASSERTIONS ────────────────────────────────────────────
 * Every copy in this story was written by someone who could not reach the layer
 * that already had the answer. The way it comes back is one screen quietly
 * retyping the string, which renders fine and errors nowhere. So these assert
 * against the SOURCE of each surface that it reaches the shared table and
 * spells no stage label itself. Same idiom as so-slip-optional-contract.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ASSR_STAGE_LABEL, assrStageLabel } from './assr-stage-labels';
import { ASSR_STAGES } from './assr/stages';

/** The BACKEND call sites are pinned by backend/tests/assrStageLabelOneHome.test.ts
 *  — the backend's own gate refereeing the backend's own surfaces. This file
 *  owns the frontend half plus the byte-identity of the pair. */
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

/** Source with comments removed — a label named in a comment is not a copy of
 *  the rule, and `expect(source).not.toContain(...)` on a 2,000-line screen
 *  prints the whole file on failure, so these assertions compare booleans. */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

describe('the two copies of this module are the same file', () => {
  /* The pair of paths is what makes the EXISTING gate referee this rule:
     backend/scripts/check-shared-mirrors.mjs --strict enumerates
     backend/src/scm/shared and looks each basename up in frontend/src/vendor/
     shared and frontend/src/vendor/scm/lib. Landing the table at exactly these
     two paths bought a CI referee with no new script — which is also why this
     file must stay at the TOP LEVEL of vendor/scm/lib and not inside assr/:
     the backend enumeration is non-recursive and the lookup is by basename. */
  test('backend/src/scm/shared/assr-stage-labels.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/scm/lib/assr-stage-labels.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/assr-stage-labels.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });
});

describe('voided has a word on every frontend surface', () => {
  test('the shared table names it', () => {
    expect(assrStageLabel('voided')).toBe('Voided — Not Valid');
  });

  test('the ordered stepper still does NOT list it, and that is correct', () => {
    /* The stepper is the funnel. A voided case is not at step 8 of 8; it left
       the funnel. Losing this distinction is the obvious wrong way to "fix"
       the missing label, so it is pinned. */
    expect(ASSR_STAGES.map((s) => s.key)).not.toContain('voided');
  });
});

describe('ASSR_STAGES owns the ORDER, not the words', () => {
  test('every stepper row reads its long label from the shared table', () => {
    for (const s of ASSR_STAGES) {
      expect(s.long, `${s.key} carries a hand-typed long label`).toBe(
        ASSR_STAGE_LABEL[s.key],
      );
    }
  });

  test('the workflow order is unchanged (Solution before Verification)', () => {
    expect(ASSR_STAGES.map((s) => s.key)).toEqual([
      'pending_review',
      'pending_solution',
      'under_verification',
      'pending_supplier_pickup',
      'pending_item_ready',
      'pending_delivery_service',
      'completed',
    ]);
  });

  test('the words themselves are unchanged from what shipped', () => {
    expect(ASSR_STAGES.map((s) => s.long)).toEqual([
      'Pending Review',
      'Pending Solution',
      'Under Verification',
      'Supplier Pickup / Return',
      'Pending Item Ready',
      'Pending Delivery / Service',
      'Completed',
    ]);
  });

  test('stages.ts spells no stage label of its own any more', () => {
    const source = code('src/vendor/scm/lib/assr/stages.ts');
    expect(source).toContain('assr-stage-labels');
    for (const label of ['Pending Review', 'Under Verification', 'Supplier Pickup / Return']) {
      expect(source.includes(`"${label}"`), `stages.ts still spells "${label}"`).toBe(false);
    }
  });
});

/* ── Every screen still reaches the shared table ─────────────────────────────
   Five surfaces spelled "Voided — Not Valid" by hand. Remove any one of these
   wirings and the assertion names the file that went its own way. */
describe('no frontend surface has re-grown its own voided label', () => {
  /* `screen` is the surface a person looks at; `labelHome` is the file on that
     surface's side that must actually import the shared table.
     They are the same file for three of the four. On mobile they are not, and
     that is deliberate rather than a leak: `prettyStage` moved into
     `src/mobile/assr-case-fields.ts` when MobileServiceCase.tsx hit its size
     ceiling. The rule did not move surfaces — it moved one hop along the same
     one — so the IMPORT is asserted where the label is resolved, and the
     "spells no literal" assertion runs over BOTH files. Nothing was dropped:
     this describe block makes strictly more assertions than it used to. */
  const SITES: Array<{ name: string; screen: string; labelHome: string }> = [
    {
      name: 'MobileServiceCase (mobile detail + timeline)',
      screen: 'src/mobile/MobileServiceCase.tsx',
      labelHome: 'src/mobile/assr-case-fields.ts',
    },
    {
      name: 'ServiceCases (desktop filter, stage select, void banner)',
      screen: 'src/pages/ServiceCases.tsx',
      labelHome: 'src/pages/ServiceCases.tsx',
    },
    {
      name: 'MyCases (agent case pills)',
      screen: 'src/pages/MyCases.tsx',
      labelHome: 'src/pages/MyCases.tsx',
    },
    {
      name: 'PortalSupplierCase (supplier portal header)',
      screen: 'src/portal/pages/PortalSupplierCase.tsx',
      labelHome: 'src/portal/pages/PortalSupplierCase.tsx',
    },
  ];

  for (const { name, screen, labelHome } of SITES) {
    test(`${name} imports the shared table`, () => {
      expect(
        read(labelHome).includes('assr-stage-labels'),
        `${name} no longer imports assr-stage-labels (checked in ${labelHome})`,
      ).toBe(true);
    });

    test(`${name} reaches its label home`, () => {
      /* A hop is only legitimate while the screen still goes through it. If
         MobileServiceCase stopped importing assr-case-fields, the assertion
         above would be checking a file nobody reads. */
      if (labelHome === screen) return;
      /* The EXACT specifier, closing quote included. A bare `includes` of
         "./assr-case-fields" is satisfied by "./assr-case-fields-RENAMED",
         which is how this assertion first shipped unable to fail — the
         "a checker that cannot match reports a clean run" trap, caught by
         renaming the import and watching the test stay green. */
      const spec = labelHome.replace(/^src\/mobile\//, './').replace(/\.tsx?$/, '');
      expect(
        code(screen).includes(`from "${spec}"`) || code(screen).includes(`from '${spec}'`),
        `${name} no longer imports ${labelHome}, so its label wiring is unchecked`,
      ).toBe(true);
    });

    for (const path of new Set([screen, labelHome])) {
      test(`${name} does not spell "Voided — Not Valid" itself (${path})`, () => {
        expect(
          code(path).includes('Voided — Not Valid'),
          `${name} has re-grown a literal voided label`,
        ).toBe(false);
      });
    }
  }

  test('mobile builds its stage confirm text from the labels, not the stepper', () => {
    /* `STAGES[STAGE_INDEX[target]]?.long ?? target` asked "Move to voided?" —
       the same missing-row hole as the portal's, in the file that had already
       patched around it once. */
    const mobile = code('src/mobile/MobileServiceCase.tsx');
    expect(mobile).toContain('prettyStage(target)');
    expect(
      mobile.includes('STAGES[STAGE_INDEX[target]]'),
      'mobile builds the confirm label from the ordered stepper again',
    ).toBe(false);
  });
});
