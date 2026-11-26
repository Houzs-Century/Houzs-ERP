import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

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
