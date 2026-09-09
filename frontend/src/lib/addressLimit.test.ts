// The number on the screen and the number the account book enforces are one
// number in two files. This is the test that says so out loud; the build-time
// guard that compares them is frontend/scripts/check-address-line-max.mjs.
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ADDRESS_LINE_MAX, addressLineProps, onAddressPaste, splitAddressAtLimit } from './addressLimit';

describe('the input limit is the account book\'s own column width', () => {
  test('it matches the backend constant, read from the backend source', () => {
    const src = readFileSync('../backend/src/services/autocount-address-fit.ts', 'utf8');
    const m = src.match(/export const AC_ADDRESS_LINE_MAX = (\d+);/);
    /* A missing match must FAIL, never pass quietly — a renamed constant would
       otherwise make this test assert nothing (CLAUDE.md: a verdict computed
       over nothing must not read as a pass). */
    expect(m, 'AC_ADDRESS_LINE_MAX not found in the backend source').toBeTruthy();
    expect(ADDRESS_LINE_MAX).toBe(Number(m?.[1]));
  });

  test('it is the 40 measured on AED_HOUZS', () => {
    expect(ADDRESS_LINE_MAX).toBe(40);
  });
});

describe('a long address breaks at a word, and the tail is never lost', () => {
  test('an address inside the column is not touched', () => {
    expect(splitAddressAtLimit('12 Jalan Bunga Raya')).toEqual({ head: '12 Jalan Bunga Raya', tail: '' });
  });

  test('the break is at a space, and line 1 fits the column', () => {
    const text = 'No 12 Jalan Perindustrian Bukit Minyak 2 Taman Perindustrian';
    const { head, tail } = splitAddressAtLimit(text);
    expect(head.length).toBeLessThanOrEqual(ADDRESS_LINE_MAX);
    expect(head.endsWith(' ')).toBe(false);
    /* NOT ONE WORD LOST, and their order kept: putting the two halves back
       together must give the original text. */
    expect(`${head} ${tail}`).toBe(text);
  });

  test('a single word wider than the column is broken rather than dropped', () => {
    const word = 'A'.repeat(90);
    const { head, tail } = splitAddressAtLimit(word);
    expect(head).toHaveLength(ADDRESS_LINE_MAX);
    expect(head + tail).toBe(word);
  });
});

describe('pasting a long address spills into the next line', () => {
  function paste(into: string, clip: string, line2: string | null) {
    const set1 = vi.fn();
    const set2 = vi.fn();
    let prevented = false;
    const el = { value: into, selectionStart: into.length, selectionEnd: into.length } as unknown as HTMLInputElement;
    onAddressPaste(
      {
        currentTarget: el,
        clipboardData: { getData: () => clip } as unknown as DataTransfer,
        preventDefault: () => { prevented = true; },
      },
      set1,
      line2 === null ? null : { value: line2, set: set2 },
    );
    return { set1, set2, prevented };
  }

  test('a paste that fits is left to the browser', () => {
    const { set1, set2, prevented } = paste('', '12 Jalan Bunga Raya', '');
    expect(prevented).toBe(false);
    expect(set1).not.toHaveBeenCalled();
    expect(set2).not.toHaveBeenCalled();
  });

  test('an over-long paste keeps every word — line 1 fits, the rest goes to line 2', () => {
    const clip = 'No 12 Jalan Perindustrian Bukit Minyak 2 Taman Perindustrian Bukit Minyak';
    const { set1, set2, prevented } = paste('', clip, '');
    expect(prevented).toBe(true);
    const head = set1.mock.calls[0][0];
    const spilled = set2.mock.calls[0][0];
    expect(head.length).toBeLessThanOrEqual(ADDRESS_LINE_MAX);
    expect(`${head} ${spilled}`).toBe(clip);
  });

  test('what the next line already held is kept, behind the spill', () => {
    const clip = 'No 12 Jalan Perindustrian Bukit Minyak 2 Taman Perindustrian';
    const { set1, set2 } = paste('', clip, 'Seri Kembangan');
    expect(`${set1.mock.calls[0][0]} ${set2.mock.calls[0][0]}`).toBe(`${clip} Seri Kembangan`);
  });

  test('the tail is NOT cut to the column — the write-back re-flows what four lines cannot hold', () => {
    /* The regression this whole handler exists to avoid: a browser truncating
       an over-long paste drops the tail for good. */
    const clip = `${'word '.repeat(20)}end`.trim();
    const { set2 } = paste('', clip, '');
    expect(set2.mock.calls[0][0].length).toBeGreaterThan(ADDRESS_LINE_MAX);
    expect(set2.mock.calls[0][0].endsWith('end')).toBe(true);
  });

  test('the LAST line has nowhere to spill, so it keeps the whole paste uncut', () => {
    const clip = 'Kawasan Perindustrian Bukit Minyak Seberang Perai Tengah Pulau Pinang';
    const { set1, prevented } = paste('', clip, null);
    expect(prevented).toBe(true);
    /* Not truncated to 40. Over the column, and the write-back re-flows it. */
    expect(set1.mock.calls[0][0]).toBe(clip);
  });

  test('a paste over a SELECTION replaces only what was selected', () => {
    const set1 = vi.fn();
    const set2 = vi.fn();
    const el = { value: 'OLD Jalan Bunga Raya', selectionStart: 0, selectionEnd: 3 } as unknown as HTMLInputElement;
    onAddressPaste(
      {
        currentTarget: el,
        clipboardData: { getData: () => 'No 12 Persiaran Perindustrian Bukit' } as unknown as DataTransfer,
        preventDefault: () => {},
      },
      set1,
      { value: '', set: set2 },
    );
    expect(`${set1.mock.calls[0][0]} ${set2.mock.calls[0][0]}`).toBe('No 12 Persiaran Perindustrian Bukit Jalan Bunga Raya');
  });
});

describe('the cap and the spill travel together', () => {
  test('the bundle carries the account book\'s width and a paste handler', () => {
    const props = addressLineProps(() => {}, null);
    expect(props.maxLength).toBe(ADDRESS_LINE_MAX);
    expect(typeof props.onPaste).toBe('function');
  });

  test('the bundle\'s onPaste spills into the line it was given', () => {
    const set1 = vi.fn();
    const set2 = vi.fn();
    const clip = 'No 12 Jalan Perindustrian Bukit Minyak 2 Taman Perindustrian';
    const props = addressLineProps(set1, { value: '', set: set2 });
    props.onPaste({
      currentTarget: { value: '', selectionStart: 0, selectionEnd: 0 } as unknown as HTMLInputElement,
      clipboardData: { getData: () => clip } as unknown as DataTransfer,
      preventDefault: () => {},
    });
    expect(`${set1.mock.calls[0][0]} ${set2.mock.calls[0][0]}`).toBe(clip);
  });
});
