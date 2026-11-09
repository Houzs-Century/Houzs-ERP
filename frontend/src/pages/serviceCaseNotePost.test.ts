import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const readAddNoteBody = (): string => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/ServiceCases.tsx'), 'utf8');
  const start = source.indexOf('async function addNote()');
  expect(start, 'ServiceCases.tsx no longer has addNote()').toBeGreaterThan(-1);
  const end = source.slice(start).search(/\r?\n {2}\}\r?\n/);
  expect(end, 'could not find the end of addNote()').toBeGreaterThan(-1);
  return source.slice(start, start + end);
};

describe('desktop service case note post', () => {
  test('a refused note post is shown to the user', () => {
    const body = readAddNoteBody();
    expect(body).toMatch(/catch\s*\(/);
    expect(body).toMatch(/toast\.error\(/);
  });

  test('a second click while posting does not post twice', () => {
    expect(readAddNoteBody()).toMatch(/isPostingNote\)\s*return/);
  });
});
