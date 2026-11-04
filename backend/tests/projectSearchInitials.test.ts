import { describe, expect, test } from 'vitest';
import { initialsLikes } from '../src/services/projects';

describe('initialsLikes', () => {
  test('a short word reads as initials, at the start of the name or inside it', () => {
    expect(initialsLikes('sccc')).toEqual(['s% c% c% c%', '% s% c% c% c%']);
  });
  test('numbers, single letters and long words are plain words', () => {
    expect(initialsLikes('mle2')).toEqual([]);
    expect(initialsLikes('ab')).toEqual([]);
    expect(initialsLikes('dataran')).toEqual([]);
  });
});
