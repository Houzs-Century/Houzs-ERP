// Four of the seventeen sofa builds AutoCount refuses are plain-seat runs that
// `tokenFor` turned away with a null, on the strength of a note that measurement
// contradicts.
import { describe, expect, it } from 'vitest';
import { composeSofaDesc2, decodesTo } from './autocount-sofa-collapse';

/* The ten models the refusals actually name, and both mechanism settings —
   `decodesTo` derives the recliner flag from the build itself. */
const MODELS = ['00913', '5527', '822', '5526', '3068', '9028', '2379', '8050', '8051', '5535'];

describe('a plain-seat build has a spelling', () => {
  it('spells a multi-seat run, which the solo guard used to refuse', () => {
    expect(composeSofaDesc2(['1S', '2S'], { size: '28' })).toBe('1S + 2S (28")');
  });

  it('STILL refuses anything containing a 3S, because that spelling is wrong', () => {
    /* `3S (28")` decodes to the two-piece build [2A(LHF), 1A(RHF)] — measured
       2026-09-09, wrong on all ten models and both mechanism settings. The
       first draft of this change removed that refusal on the strength of a
       measurement taken WITHOUT the size suffix a real build carries. */
    expect(composeSofaDesc2(['3S'], { size: '28' })).toBeNull();
    expect(composeSofaDesc2(['3S', '1S', '2S'], { size: '28' })).toBeNull();
  });

  it('round-trips on every model the refusals name', () => {
    /* The claim the change rests on, asserted rather than quoted: the composed
       text decodes back to exactly the build, for each of the ten models. */
    for (const build of [['2S'], ['1S'], ['1S', '2S']]) {
      /* WITH the size a real build carries. Without it the decoder answers
         differently, which is how the first draft of this change measured a
         spelling for 3S that does not exist. */
      const text = composeSofaDesc2(build, { size: '28' });
      expect(text, `no spelling for ${build.join('+')}`).not.toBeNull();
      for (const model of MODELS) {
        const v = decodesTo(text as string, model, build, { size: '28' });
        expect(v.ok, `${build.join('+')} on ${model}: ${v.ok ? '' : v.why}`).toBe(true);
      }
    }
  });

  it('still refuses a build it cannot spell, rather than approximating it', () => {
    /* The guard that makes proposing a spelling safe: a compartment with no
       token still returns null, and the caller refuses. A solo CNR has no
       spelling — measured the same day, no one- or two-token string decodes to
       it. */
    expect(composeSofaDesc2(['CNR'], { size: '28' })).toBeNull();
  });

  it('leaves the armed-end spellings exactly as they were', () => {
    /* Those two are the measured corrections that took the inverse from 86.2%
       to 98.7% — an armed END piece is nEL / nER, never a bare digit. Nothing
       here may touch them. */
    expect(composeSofaDesc2(['2A(RHF)', '1A(LHF)'], { size: '28' })).toBe('2ER + 1EL (28")');
    expect(composeSofaDesc2(['1NA'], { size: '28' })).toBe('1NA (28")');
  });
});
