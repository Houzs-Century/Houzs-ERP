import { describe, expect, it } from 'vitest';
import { composeSofaDesc2, decodesTo } from './autocount-sofa-collapse';

const MODELS = ['00913', '5527', '822', '5526', '3068', '9028', '2379', '8050', '8051', '5535'];

describe('a plain-seat build has a spelling', () => {
  it('spells a multi-seat run, which the solo guard used to refuse', () => {
    expect(composeSofaDesc2(['1S', '2S'], { size: '28' })).toBe('1S + 2S (28")');
  });

  it('a SIZED 3S still never reaches the book — the GATE refuses it now', () => {
    for (const model of MODELS) {
      const sized = composeSofaDesc2(['3S'], { size: '28' });
      expect(decodesTo(sized as string, model, ['3S'], { size: '28' }).ok, model).toBe(false);
      const three = composeSofaDesc2(['3S', '1S', '2S'], { size: '28' });
      expect(decodesTo(three as string, model, ['3S', '1S', '2S'], { size: '28' }).ok, model).toBe(false);
    }
  });

  it('and a SIZELESS 3S round-trips on every model, which is why it is written', () => {
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
    for (const build of [['2S'], ['1S'], ['1S', '2S']]) {
      const text = composeSofaDesc2(build, { size: '28' });
      expect(text, `no spelling for ${build.join('+')}`).not.toBeNull();
      for (const model of MODELS) {
        const v = decodesTo(text as string, model, build, { size: '28' });
        expect(v.ok, `${build.join('+')} on ${model}: ${v.ok ? '' : v.why}`).toBe(true);
      }
    }
  });

  it('still refuses a build it cannot spell, rather than approximating it', () => {
    expect(composeSofaDesc2(['CNR'], { size: '28' })).toBeNull();
  });

  it('leaves the armed-end spellings exactly as they were', () => {
    expect(composeSofaDesc2(['2A(RHF)', '1A(LHF)'], { size: '28' })).toBe('2ER + 1EL (28")');
    expect(composeSofaDesc2(['1NA'], { size: '28' })).toBe('1NA (28")');
  });
});
