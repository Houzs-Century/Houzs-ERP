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

/** Comments quote the shapes this file is about — strip them. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const POS = code(posSrc);

describe('sales-stats — targeting another salesperson', () => {
  test('the param is read', () => {
    expect(POS).toMatch(/c\.req\.query\("salesperson"\)/);
  });

  test('targeting is GATED on canViewAllSales, server-side', () => {
    /* The whole security argument. Without this the endpoint hands any
       authenticated salesperson a colleague's month. */
    expect(POS).toMatch(/mayTarget[\s\S]{0,120}canViewAllSales\(c\)/);
  });

  test('the gate is not satisfiable by the empty or "all" value', () => {
    expect(POS).toMatch(/wantSalesperson !== ""/);
    expect(POS).toMatch(/wantSalesperson !== "all"/);
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

  test('canViewAllSales is actually imported, not shadowed by a local truthy', () => {
    /* RAW source, not the comment-stripped copy: `code()` also removes the
       import block (a `/*` inside an earlier import's trailing comment swallows
       it), and an import can never be inside a comment anyway. */
    expect(posSrc).toMatch(/import \{ canViewAllSales \} from/);
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
