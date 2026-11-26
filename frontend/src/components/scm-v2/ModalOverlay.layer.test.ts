import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const zs = (text: string) => [...text.matchAll(/"fixed [^"]*\bz-\[(\d+)\]/g)].map((m) => Number(m[1]));

describe('ModalOverlay layer', () => {
  it('sits above the side drawers', () => {
    const file = src('DocumentRelationshipMapModal.tsx');
    const start = file.indexOf('export function ModalOverlay(');
    const overlay = zs(file.slice(start, file.indexOf('\nexport function', start + 1)));
    expect(overlay.length).toBe(2);
    const drawers = [...zs(src('../ResizableDetailDrawer.tsx')), ...zs(src('../ResizableDrawer.tsx'))];
    expect(drawers.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...overlay)).toBeGreaterThan(Math.max(...drawers));
  });
});
