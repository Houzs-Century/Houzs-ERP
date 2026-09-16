/* An order written BEFORE the sofa-exclusivity rule existed must stay editable
   from the phone.

   ── THE BUG ────────────────────────────────────────────────────────────────
   The server refuses only a change that INTRODUCES a sofa/main-product mix
   (`mainMixIntroduced`), so a pre-rule mixed order is grandfathered and its
   phone number, address or delivery date can still be corrected. Desktop moved
   to the matching differential form in #2395 (`SalesOrderDetail.tsx` →
   `sofaMixIntroduced(storedGroups, editedGroups)`); mobile kept the FLAT
   `hasSofaMixConflict` over the edited lines, and that guard sits ABOVE the
   edit branch inside `save()`, so it fired on edits too. A rep on such an order
   could not save ANY change from the phone, and the sentence blamed a rule the
   server itself grandfathers.

   ── WHY SOURCE TEXT AND NOT A RENDER ───────────────────────────────────────
   `MobileNewSO` is a 3,700-line screen whose `save()` is unreachable without
   mounting the whole form, and what matters is precisely WHICH predicate feeds
   the guard and WHICH set it measures against — exactly what the text shows and
   what a mocked render would paper over. Same idiom, and the same reasoning, as
   `vendor/scm/lib/so-slip-optional-contract.test.ts`. The RULE itself is unit
   tested for real in `vendor/shared/so-variant-rule.test.ts`; the pair below
   re-states the two cases this guard turns on so the contract is readable here. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { hasSofaMixConflict, sofaMixIntroduced } from '../vendor/shared/so-variant-rule';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

const mobileSource = read('src/mobile/MobileNewSO.tsx');
const desktopDetailSource = read('src/pages/scm-v2/SalesOrderDetail.tsx');

/** Body of `async function save(` up to the next top-level declaration. */
const saveBody = (): string => {
  const start = mobileSource.indexOf('async function save(asDraft = false) {');
  expect(start, 'MobileNewSO save() anchor not found').toBeGreaterThan(-1);
  const end = mobileSource.indexOf('const patchLine = (key: string', start);
  expect(end, 'MobileNewSO save() end anchor not found').toBeGreaterThan(start);
  return mobileSource.slice(start, end);
};

describe('the rule the guard has to match', () => {
  test('a pre-rule mixed order is grandfathered — re-saving it introduces nothing', () => {
    expect(hasSofaMixConflict(['sofa', 'bedframe'])).toBe(true);
    expect(sofaMixIntroduced(['sofa', 'bedframe'], ['sofa', 'bedframe'])).toBe(false);
  });

  test('adding a sofa to a bedframe order still IS introducing the mix', () => {
    expect(sofaMixIntroduced(['bedframe'], ['bedframe', 'sofa'])).toBe(true);
  });
});

describe('mobile hands the differential question to the backend, like the server', () => {
  /* Since 2026-09-16 the BACKEND is the authority (owner: frontend 只是显示). The
     phone posts its draft to /mfg-sales-orders/validate and the endpoint computes
     mixes(after) && !mixes(before) from the draft's line groups — so the phone
     holds NO mix rule of its own, flat or differential. The "before" set is the
     order's STORED lines, carried in the draft as origItemGroups. */
  const draftBody = (): string => {
    const start = mobileSource.indexOf('const buildSoValidateDraft = useCallback((asDraftFlag: boolean) => ({');
    expect(start, 'buildSoValidateDraft anchor not found').toBeGreaterThan(-1);
    const end = mobileSource.indexOf('}), [', start);
    expect(end, 'buildSoValidateDraft end anchor not found').toBeGreaterThan(start);
    return mobileSource.slice(start, end);
  };

  test('save() posts to the backend validate and keeps NO client mix rule', () => {
    const body = saveBody();
    expect(body, 'mobile save() must reach the backend authority').toContain('/mfg-sales-orders/validate');
    expect(body, 'the phone must not keep the flat create-path rule').not.toContain('hasSofaMixConflict(');
    expect(body, 'the phone must not keep a client differential rule either').not.toContain('sofaMixIntroduced(');
  });

  test('the draft carries the STORED line groups as origItemGroups (the "before" set)', () => {
    /* Fed the edited set twice, the backend differential collapses to the flat
       rule and can never see the mix was already there. The persisted lines are
       origItems (seeded from the detail prefill). */
    expect(draftBody()).toContain('origItemGroups: origItems.map((it) => it.item_group)');
  });

  test('desktop still asks the same question — the two surfaces move together', () => {
    /* SalesOrderDetail now feeds the sofa-mix rule into the shared
       collectSoEditSaveProblems aggregator, but the DIFFERENTIAL form is intact:
       the before-set is the STORED lines (`items`), the after-set the edited
       drafts, and the flat create-path rule is gone. */
    expect(desktopDetailSource).toContain('sofaMixIntroduced(items.map((it) => it.item_group)');
    expect(desktopDetailSource, 'desktop must not fall back to the flat create-path rule on an EDIT')
      .not.toContain('hasSofaMixConflict(');
  });
});
