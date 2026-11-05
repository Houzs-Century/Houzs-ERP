import { describe, expect, test } from 'vitest';
import { bestLines, printedSize } from './scan-word-match';

const same = (s: string) => s;

describe('printedSize', () => {
  test('reads a width or feet the way our codes spell the size', () => {
    expect(printedSize('DUN CS2 PURE BREEZE MAT 190X152X30CM MAL')).toBe('Q');
    expect(printedSize('DUN CL DREAM VALLEY MAT 190X107X34CM')).toBe('SS');
    expect(printedSize('FABRIC 3 DIVAN BED Size: 5 FTS')).toBe('Q');
    expect(printedSize('no size here')).toBeNull();
  });
});

describe('bestLines', () => {
  test("Dunlopillo's short names find our line at the right size", () => {
    const lines = ['DUNLOPILLO COOLSILK 2.0 PURE BREEZE MATT (Q) DL-CS2 PURE BREEZE (Q)', 'DUNLOPILLO COOLSILK 2.0 PURE BREEZE MATT (K) DL-CS2 PURE BREEZE (K)', 'DUNLOPILLO CS2 GLACIAL COMFORT MATT (K) DL-CS2 GLACIAL COMFORT (K)'];
    expect(bestLines('DUN CS2 PURE BREEZE MAT 190X152X30CM MAL', lines, same)).toEqual([lines[0]]);
  });
  test('a model word on the supplier code is enough; both pieces of it stay candidates', () => {
    const lines = ['9050-1A(LHF) AMN-SF9050 SOFA 1A(LHF)', '9050-1B(RHF) AMN-SF9050 SOFA 1B(RHF)', '9036-1A AMN-SF9036 SOFA 1A'];
    expect(bestLines('SF9050 - 1EPL + 1B (32") COL: HR805-10', lines, same)).toHaveLength(1);
    expect(bestLines('SF9050 - 1EPL', lines, same)).toEqual([lines[0], lines[1]]);
  });
  test('words that only name the kind of thing match nothing', () => {
    expect(bestLines('SOFA MATT BEDFRAME', ['CODY BEDFRAME (Q)'], same)).toEqual([]);
    expect(bestLines('GLACIAL', ['CS2 GLACIAL COMFORT (K)'], same)).toEqual([]);
  });
});
