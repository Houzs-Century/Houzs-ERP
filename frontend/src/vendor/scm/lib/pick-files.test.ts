/* The picked files are read before the input is reset (owner 2026-10-15: 选了
   PDF 之后是空的). A real browser empties `files` the moment `value` is set to
   ''; this input does the same, so reading in the wrong order returns nothing. */
import { describe, expect, test } from 'vitest';
import { takePickedFiles } from './pick-files';

const browserLikeInput = (files: File[]): HTMLInputElement => {
  const input = document.createElement('input');
  input.type = 'file';
  let served = files;
  Object.defineProperty(input, 'files', { configurable: true, get: () => served });
  Object.defineProperty(input, 'value', { configurable: true, get: () => (served.length ? 'fakepath/x' : ''), set: (v: string) => { if (v === '') served = []; } });
  return input;
};

describe('takePickedFiles', () => {
  test('hands over the picked files and leaves the input reset for the next pick', () => {
    const quote = new File(['%PDF-1.4'], 'quotation.pdf', { type: 'application/pdf' });
    const photo = new File(['jpg'], 'sample.jpg', { type: 'image/jpeg' });
    const input = browserLikeInput([quote, photo]);
    expect(takePickedFiles(input).map((f) => f.name)).toEqual(['quotation.pdf', 'sample.jpg']);
    expect(input.value).toBe('');
    expect(input.files?.length ?? 0).toBe(0);
  });
  test('reading after the reset is what loses the files — the order this helper fixes', () => {
    const input = browserLikeInput([new File(['x'], 'x.pdf', { type: 'application/pdf' })]);
    input.value = '';
    expect(Array.from(input.files ?? [])).toEqual([]);
  });
  test('no pick: nothing, and no throw', () => {
    expect(takePickedFiles(browserLikeInput([]))).toEqual([]);
  });
});
