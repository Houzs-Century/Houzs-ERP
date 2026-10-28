// ----------------------------------------------------------------------------
// /pos/sales-stats — whose numbers the Personal card holds, and under whose name.
//
// THE DEFECT. The POS board filters by ?salesperson; this card never did — the
// route read the param and ignored it, so a director picking "SCARLETT" saw
// SCARLETT on the tile and HIS OWN two orders under it. Two people's tiles
// showed the same RM 2,990 because both were really the caller's.
//
// THE HAZARD IN FIXING IT. The param arrives from a browser. The POS already
// gates the picker on canSeeAll, but a client-side gate is not a permission: a
// salesperson can send ?salesperson=<colleague> by hand. So the gate has to live
// HERE. That is what this file pins — not the arithmetic, which the aggregate
// SQL owns, but WHO may ask for whom.
//
// Source-level, in the soProceedRefusalWiring idiom: the failure mode is a gate
// going missing, which a test over the response body cannot see when the fixture
// happens to be authorised.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import posSrc from '../src/routes/pos.ts?raw';
import { canTargetSalesperson } from '../src/routes/pos';

/** Comments quote the shapes this file is about — strip them. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const POS = code(posSrc);

describe('sales-stats — targeting another salesperson', () => {
  test('the param is read', () => {
    expect(POS).toMatch(/c\.req\.query\("salesperson"\)/);
  });

  test('the gate EXECUTES — the shapes that killed its two predecessors', () => {
    /* Not a source pin. Version 1 called a helper whose required context this
       route never has (gate always closed); version 2 handed hasPermission the
       USER where it takes the PERMISSIONS (`user.has is not a function`, 500,
       both tiles "Couldn't load"). Both passed source-text pins. This calls the
       real function with the real session-user shape (services/auth.ts:
       permissions_set is a Set, position_name a string). */
    const director = { position_name: 'Sales Director', permissions_set: new Set<string>() };
    const flatKey = { position_name: null, permissions_set: new Set(['scm.so.view_all']) };
    const star = { position_name: null, permissions_set: new Set(['*']) };
    const plainSales = { position_name: 'Sales Person', permissions_set: new Set<string>() };

    expect(canTargetSalesperson(director, 'some-uuid')).toBe(true);   // v1's dead arm
    expect(canTargetSalesperson(flatKey, 'some-uuid')).toBe(true);
    expect(canTargetSalesperson(star, 'some-uuid')).toBe(true);
    expect(canTargetSalesperson(plainSales, 'some-uuid')).toBe(false); // the security half
    expect(canTargetSalesperson(undefined, 'some-uuid')).toBe(false);  // no session shape
    expect(canTargetSalesperson(director, '')).toBe(false);
    expect(canTargetSalesperson(director, 'all')).toBe(false);
    // v2's crash shape: a Set-carrying user must not throw, ever
    expect(() => canTargetSalesperson(director, 'x')).not.toThrow();
  });

  test('targeting is GATED server-side — flat key OR director position, off the REAL user', () => {
    /* The whole security argument. Without this the endpoint hands any
       authenticated salesperson a colleague's month.

       NOT canViewAllSales(c): its director arm reads `houzsUser`, which only
       scm/middleware/auth.ts stashes — on /api/pos it is never set, so a Sales
       Director (the person the picker exists FOR) always failed the gate and
       the tile silently fell back to the caller. Here `user` IS the real Houzs
       caller, so both arms run directly off it. */
    expect(POS).toMatch(/canTargetSalesperson\(/);
    expect(POS).toMatch(/hasPermission\(perms, "scm\.so\.view_all"\)/);
    expect(POS).toMatch(/isDirectorUser\(/);
  });

  test('the lookup matches what the picker SENDS — the staff id — with the uuid guard', () => {
    /* The POS picker sends `<option value={s.id}>`. The first version matched
       staff.name, so every lookup missed and fell back to the caller: the label
       changed, the numbers did not. Guarded by shape because a malformed value
       on a uuid column is a 22P02 500, not a miss. Name stays as the non-uuid
       arm for hand-typed use. */
    expect(POS).toMatch(/UUID_RX\.test\(wantSalesperson\)/);
    expect(POS).toMatch(/WHERE id = \? LIMIT 1/);
    expect(POS).toMatch(/WHERE name = \? LIMIT 1/);
  });

  test('the gate is not satisfiable by the empty or "all" value', () => {
    /* Followed into canTargetSalesperson — and asserted EXECUTABLY above too
       (director + '' / 'all' both refuse). This textual half only keeps the
       guard from being edited out of the function. */
    expect(POS).toMatch(/wantSalesperson === "" \|\| wantSalesperson === "all"/);
  });

  test('an unauthorised or unknown name falls back to the CALLER, never to everyone', () => {
    /* `target?.id ?? me.id` — the fallback is the caller's own id. A fallback of
       "no filter" would silently widen the card to the whole company, which is
       the opposite of the intent and would leak more than the bug did. */
    expect(POS).toMatch(/target\?\.id \?\? me\.id/);
  });

  test('the tile is labelled with WHOSE figures it holds', () => {
    /* The name and the number must move together — that they did not is the
       entire defect. */
    expect(POS).toMatch(/staffName: target\?\.name \?\? me\.name/);
  });

  test('the gate helpers are actually imported, not shadowed by a local truthy', () => {
    /* RAW source, not the comment-stripped copy: `code()` also removes the
       import block, and an import can never be inside a comment anyway. */
    expect(posSrc).toMatch(/import \{ hasPermission \} from "\.\.\/services\/permissions"/);
    expect(posSrc).toMatch(/import \{ isDirectorUser \} from "\.\.\/services\/pmsAccess"/);
  });
});

describe('sales-stats — which scope the Showroom card counted', () => {
  test('the response says whether it was the showroom or the whole company', () => {
    /* Staff WITH a showroom get their mates; staff WITHOUT one get the company.
       Both rendered as "Showroom", so a director read company-wide figures under
       a showroom heading. The POS labels the tile from this field. */
    expect(POS).toMatch(/showroomScope: me\.showroom_id \? "showroom" : "company"/);
  });

  test('the empty response carries it too, so a staffless caller still labels correctly', () => {
    expect(POS).toMatch(/showroomScope: me\?\.showroom_id \? "showroom" : "company"/);
  });

  test('the scope FLAG did not change the scope itself', () => {
    /* This PR relabels; it must not move anybody's numbers. The showroom-mates
       query and its "else the whole company" default stay exactly as they were. */
    expect(POS).toMatch(/SELECT id FROM scm\.staff WHERE showroom_id = \?/);
    expect(POS).toMatch(/showroomWhere = `salesperson_id IN \(/);
  });
});
