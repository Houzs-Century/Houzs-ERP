import { describe, expect, it } from 'vitest';
import { initialsOf } from './calendarModel';

describe('initialsOf', () => {
  it('takes the first letter of each word', () => {
    expect(initialsOf('SETIA CITY CONVENTION CENTRE')).toBe('sccc');
    expect(initialsOf(null)).toBe('');
  });
});
