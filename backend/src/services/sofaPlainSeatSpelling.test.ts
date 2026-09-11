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

  it('a SIZED 3S still never reaches the book — the GATE refuses it now', () => {
    /* CHANGED 2026-09-10, and the warning this test was written to carry is
       still right and is exactly why the change is shaped this way. `3S (28")`
       decodes to the two-piece build [2A(LHF), 1A(RHF)] — wrong on all ten
       models and both mechanism settings — and that must never be written.

       What moved is WHERE it is refused. `tokenFor` now PROPOSES `3S`, and
       `decodesTo`, which sees the real seat size, turns the sized case away.
       Withholding the token refused the SIZELESS case too, and that is the case
       the two documents have: production, 2026-09-10, reports `seat size NONE`
       for HC-SO-001640 [3S] and HC-SO-001472 [3S, 1S, 2S]. */
    for (const model of MODELS) {
      const sized = composeSofaDesc2(['3S'], { size: '28' });
      expect(decodesTo(sized as string, model, ['3S'], { size: '28' }).ok, model).toBe(false);
      const three = composeSofaDesc2(['3S', '1S', '2S'], { size: '28' });
      expect(decodesTo(three as string, model, ['3S', '1S', '2S'], { size: '28' }).ok, model).toBe(false);
    }
  });

  it('and a SIZELESS 3S round-trips on every model, which is why it is written', () => {
    /* The claim the change rests on, measured the same way as the one above
       rather than argued from it. */
    for (const build of [['3S'], ['3S', '1S', '2S']]) {
      const text = composeSofaDesc2(build, { size: null });
      expect(text, `no spelling for ${build.join('+')}`).not.toBeNull();
      for (const model of MODELS) {
        const v = decodesTo(text as string, model, build, { size: null });
        expect(v.ok, `${build.join('+')} on ${model}: ${v.ok ? '' : v.why}`).toBe(true);
      }
    }
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
