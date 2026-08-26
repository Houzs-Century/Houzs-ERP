// ----------------------------------------------------------------------------
// THE PAGE AND THE SERVER MUST AGREE ON WHAT A TOKEN LOOKS LIKE.
//
// The basket parses the token out of a decoded QR before anything is sent; the
// server re-checks the shape before any query. Two regexes, two files, one fact
// — and the failure mode when they drift is silent in the worst way: the page
// simply DROPS the scan, so the operator sees a code that "does not scan" while
// the server, which would have resolved it perfectly, is never asked.
//
// That risk is why this test reads BOTH FILES rather than importing a shared
// constant. The constant cannot be shared: the parser has to find a token inside
// a URL (so it is anchored to `/d/` and a boundary) while the gate matches a
// whole string, and a single expression doing both would be less clear than two
// that are checked against each other. What is asserted is the SET OF STRINGS
// they accept, not their text.
//
// 2026-08-27: the accepted set became two shapes rather than one — a 10-char
// token so the printed code could shrink to 14mm, plus the 64-hex form every
// paper already on a lorry still carries.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

/** Pull a literal regex out of a source file by the name it is assigned to. */
function regexNamed(source: string, name: string): RegExp {
  const m = new RegExp(`${name}\\s*=\\s*(/.+/[a-z]*);`).exec(source);
  if (!m) throw new Error(`no regex literal named ${name} — did it get renamed?`);
  const body = m[1]!;
  const lastSlash = body.lastIndexOf('/');
  return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
}

const GATE = regexNamed(read('../../../backend/src/scm/lib/do-scan-token.ts'), 'DO_SCAN_TOKEN_RE');
const PARSER = regexNamed(read('./PublicDoScanBasket.tsx'), 'TOKEN_IN_URL');

const SHORT = 'k3m9p2vx7q';
const LEGACY = 'a'.repeat(64);

const parsed = (token: string): string | null =>
  PARSER.exec(`https://erp.houzscentury.com/d/${token}`)?.[1]?.toLowerCase() ?? null;

describe('the page and the server accept the same tokens', () => {
  test('both live shapes are accepted by BOTH', () => {
    for (const t of [SHORT, LEGACY]) {
      expect(GATE.test(t), `server rejected ${t.length}-char token`).toBe(true);
      expect(parsed(t), `page dropped ${t.length}-char token`).toBe(t);
    }
  });

  test('neither accepts a shape the other would refuse', () => {
    /* The interesting rejects: a length between the two shapes, the letters
       Crockford drops because they are misread off paper, and the near-misses
       either side of each length. */
    const rejects = [
      '', 'k3m9p2vx7', 'k3m9p2vx7qq', 'k3m9p2vx7i', 'k3m9p2vx7l', 'k3m9p2vx7o', 'k3m9p2vx7u',
      'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(32), 'z'.repeat(64), 'batch',
    ];
    for (const t of rejects) {
      expect(GATE.test(t), `server accepted "${t.slice(0, 12)}…" (${t.length})`).toBe(false);
      expect(parsed(t), `page accepted "${t.slice(0, 12)}…" (${t.length})`).not.toBe(t);
    }
  });

  test('the 10-char shape is what makes the small print possible — 29 modules, not 41', async () => {
    /* Stated here rather than only in a comment: the shape and the millimetres
       are one decision. If a future edit lengthens the token, this fails and
       points at the print, which is the thing that would otherwise silently
       stop scanning. */
    // @ts-ignore — same typings pragma the drawer carries.
    const { default: qrcode } = await import('qrcode-generator');
    const modules = (t: string) => {
      const q = qrcode(0, 'M');
      q.addData(`https://erp.houzscentury.com/d/${t}`);
      q.make();
      return q.getModuleCount();
    };
    expect(modules(SHORT)).toBe(29);
    expect(14 / (modules(SHORT) + 4)).toBeGreaterThanOrEqual(0.42);
  });
});
