
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ASSR_STAGE_LABEL, assrStageLabel } from './assr-stage-labels';
import { ASSR_STAGES } from './assr/stages';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

describe('the two copies of this module are the same file', () => {
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
      'Pickup / Return',
      'Pending Item Ready',
      'Pending Delivery / Service',
      'Completed',
    ]);
  });

  test('stages.ts spells no stage label of its own any more', () => {
    const source = code('src/vendor/scm/lib/assr/stages.ts');
    expect(source).toContain('assr-stage-labels');
    for (const label of ['Pending Review', 'Under Verification', 'Pickup / Return']) {
      expect(source.includes(`"${label}"`), `stages.ts still spells "${label}"`).toBe(false);
    }
  });
});

describe('no frontend surface has re-grown its own voided label', () => {
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
      if (labelHome === screen) return;
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
    const mobile = code('src/mobile/MobileServiceCase.tsx');
    expect(mobile).toContain('prettyStage(target)');
    expect(
      mobile.includes('STAGES[STAGE_INDEX[target]]'),
      'mobile builds the confirm label from the ordered stepper again',
    ).toBe(false);
  });
});

const declarationOf = (source: string, name: string): string => {
  const at = source.indexOf(`const ${name}`);
  expect(at, `${name} disappeared from the source`).toBeGreaterThan(-1);
  const rest = source.slice(at);
  const end = rest.search(/[\])]\s*;/);
  expect(end, `${name} initialiser has no recognisable end`).toBeGreaterThan(-1);
  return rest.slice(0, end + 2);
};

describe('the desktop detail table spells no stage word of its own', () => {
  const DESKTOP = 'src/pages/ServiceCases.tsx';

  test('DETAIL_STAGES is DERIVED from ASSR_STAGES, not retyped under it', () => {
    const decl = declarationOf(code(DESKTOP), 'DETAIL_STAGES');
    expect(decl, 'DETAIL_STAGES no longer reads the canonical table').toContain(
      'ASSR_STAGES',
    );
  });

  test('the declaration quotes no stage wording at all', () => {
    const decl = declarationOf(code(DESKTOP), 'DETAIL_STAGES');
    const words = [
      ...Object.values(ASSR_STAGE_LABEL),
      'Review',
      'Solution',
      'Verification',
      'Delivery / Service',
    ];
    for (const word of words) {
      expect(
        decl.includes(`"${word}"`) || decl.includes(`'${word}'`),
        `DETAIL_STAGES has re-grown a hand-typed "${word}"`,
      ).toBe(false);
    }
  });
});

describe('the desktop stage picker offers the ACTIVE stages of the case', () => {
  test('the "Change to" select maps the filtered prop, never the module table', () => {
    const source = code('src/pages/ServiceCases.tsx');
    let at = -1;
    for (let i = source.indexOf('Change to'); i > -1; i = source.indexOf('Change to', i + 1)) {
      const next = source.indexOf('<select', i);
      if (next > -1 && next - i < 400) {
        at = i;
        break;
      }
    }
    expect(at, 'no "Change to" label opens a <select> any more').toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf('</select>', at));
    expect(
      block.includes('DETAIL_STAGES.map'),
      'the stage picker maps the UNFILTERED DETAIL_STAGES again — an internal-resolution case would offer the two supplier-only stages',
    ).toBe(false);
    expect(block, 'the stage picker no longer maps the filtered `stages` prop').toContain(
      'stages.map',
    );
  });
});
