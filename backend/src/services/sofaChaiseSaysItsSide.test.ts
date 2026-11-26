import { describe, expect, it } from 'vitest';
import { composeSofaDesc2, decodesTo } from './autocount-sofa-collapse';

const MODELS = ['9028', '5526', '5527', '822', '3068', '00913', '2379', '8050', '8051', '5535'];
const SIZE = { size: '28' };

describe('a chaise can say which side it is on', () => {
  it('writes the three builds that had no spelling at all', () => {
    expect(composeSofaDesc2(['2A(RHF)', 'L(LHF)'], SIZE)).toBe('2ER + LL (28")');
    expect(composeSofaDesc2(['L(RHF)', '2A(LHF)'], SIZE)).toBe('LR + 2EL (28")');
    expect(composeSofaDesc2(['L(RHF)', '1NA', '2A(LHF)'], SIZE)).toBe('LR + 1NA + 2EL (28")');
  });

  it('leaves the POSITIONAL spelling exactly as it was', () => {
    expect(composeSofaDesc2(['L(LHF)', '2A(RHF)'], SIZE)).toBe('L + 2ER (28")');
  });

  it('round-trips on every model, which is what the gate actually checks', () => {
    for (const build of [
      ['2A(RHF)', 'L(LHF)'], ['L(RHF)', '2A(LHF)'],
      ['L(RHF)', '1NA', '2A(LHF)'], ['L(LHF)', '2A(RHF)'],
    ]) {
      const text = composeSofaDesc2(build, SIZE);
      expect(text, `no spelling for ${build.join('+')}`).not.toBeNull();
      for (const model of MODELS) {
        const v = decodesTo(text as string, model, build, SIZE);
        expect(v.ok, `${build.join('+')} on ${model}: ${v.ok ? '' : v.why}`).toBe(true);
      }
    }
  });

  it('still refuses the shapes this change does NOT reach', () => {
    expect(composeSofaDesc2(['1A(LHF)'], SIZE)).toBeNull();
    expect(composeSofaDesc2(['CNR'], SIZE)).toBeNull();
  });
});
