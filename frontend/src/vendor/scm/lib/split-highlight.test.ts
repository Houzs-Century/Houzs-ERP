import { describe, it, expect } from 'vitest';
import { splitHighlight } from './split-highlight';

describe('splitHighlight', () => {
  it('marks a match in the middle', () => {
    expect(splitHighlight('BIGHOME @ KLCC', 'home')).toEqual([
      { text: 'BIG', hit: false },
      { text: 'HOME', hit: true },
      { text: ' @ KLCC', hit: false },
    ]);
  });

  it('is case-insensitive and keeps the original casing in the segment', () => {
    expect(splitHighlight('Johor', 'JOH')).toEqual([
      { text: 'Joh', hit: true },
      { text: 'or', hit: false },
    ]);
  });

  it('marks every occurrence', () => {
    expect(splitHighlight('a-a-a', 'a')).toEqual([
      { text: 'a', hit: true },
      { text: '-', hit: false },
      { text: 'a', hit: true },
      { text: '-', hit: false },
      { text: 'a', hit: true },
    ]);
  });

  it('treats the query literally (no regex)', () => {
    expect(splitHighlight('HOMEDEC @ KLCC', '@ kl')).toEqual([
      { text: 'HOMEDEC ', hit: false },
      { text: '@ KL', hit: true },
      { text: 'CC', hit: false },
    ]);
  });

  it('no match returns the whole string unmarked', () => {
    expect(splitHighlight('BIGHOME', 'zzz')).toEqual([{ text: 'BIGHOME', hit: false }]);
  });

  it('empty query returns the whole string unmarked', () => {
    expect(splitHighlight('BIGHOME', '   ')).toEqual([{ text: 'BIGHOME', hit: false }]);
  });

  it('empty text returns nothing', () => {
    expect(splitHighlight('', 'x')).toEqual([]);
  });
});
