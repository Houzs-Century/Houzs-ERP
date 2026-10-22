import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_FACES } from './pdf-common';

const FONT_DIR = resolve(__dirname, '../../../../public/fonts');
const sha8 = (file: string): string =>
  createHash('sha256').update(readFileSync(resolve(FONT_DIR, file))).digest('hex').slice(0, 8);

// /fonts/* is immutable for a year: a subset whose bytes change under the same
// name never reaches a browser that printed before (KŌRI refused again on
// 2026-10-20 after #4705 regenerated the faces in place).
describe('PDF Noto subsets are named by content', () => {
  const urls = Object.values(TIER_FACES).flatMap((faces) => Object.values(faces));

  it.each(urls)('%s carries the sha256 of its bytes', (url) => {
    const file = url.replace('/fonts/', '');
    const m = /^noto-sans-sc-(punct|hanzi)-(400|700)\.([0-9a-f]{8})\.ttf$/.exec(file);
    expect(m, `${file} must be noto-sans-sc-<tier>-<weight>.<sha8>.ttf`).not.toBeNull();
    expect(m![3]).toBe(sha8(file));
  });

  it('no stale subset is left in public/fonts', () => {
    const onDisk = readdirSync(FONT_DIR).filter((f) => /^noto-sans-sc-(punct|hanzi)-/.test(f));
    expect(onDisk.sort()).toEqual(urls.map((u) => u.replace('/fonts/', '')).sort());
  });
});
