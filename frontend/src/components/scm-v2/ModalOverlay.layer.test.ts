import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* Sister-ERP gap review P12: ModalOverlay (print preview, document map, choice
   dialog) was z-80/81 while the side drawers are z-90/91, so a print preview
   opened from a list's quick-view drawer appeared behind the drawer. Every
   layer of the overlay must sit strictly above every layer of both drawers. */
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
