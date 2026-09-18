/* The Sales Order router's source is read as a FAMILY — the router file plus
   every file a register/mount call in it comes from — so a handler moved out of
   mfg-sales-orders.ts stays inside every source assertion written against it.
   These pin the reader itself: a family that quietly stopped at the router file
   would turn every absence assertion in the suite into a pass over nothing. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { expandRouterFamily } from '../scripts/lib/router-family.mjs';
import { soRouterFiles, soRouterSource } from './lib/so-router-source';

const backendRoot = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(backendRoot, rel), 'utf8');

describe('expandRouterFamily', () => {
  const tree: Record<string, string> = {
    'r/main.ts': [
      "import { registerARoutes } from './main/a';",
      "import { mountHoldRoute } from './hold';",
      'export const main = 1;',
      "main.get('/static', h);",
      'registerARoutes(main);',
      "main.get('/:docNo', h);",
      '// registerGhostRoutes(main);',
      "mountHoldRoute(main, 'so');",
      'function registerLocalRoutes(r) {}',
      'registerLocalRoutes(main);',
    ].join('\n'),
    'r/main/a.ts': "import { registerBRoutes } from './b';\nexport function registerARoutes(r) {\n  r.get('/a', h);\n  registerBRoutes(r);\n}",
    'r/main/b.ts': "export function registerBRoutes(r) { r.get('/b', h); }",
    'r/hold.ts': "export function mountHoldRoute(r, d) { r.patch(PATHS[d], h); }",
  };
  const readTree = (key: string) => tree[key] ?? null;

  test('inlines each file right after its call, keeping registration order, nested calls included', () => {
    const { source, files } = expandRouterFamily('r/main.ts', readTree);
    expect(files).toEqual(['r/main.ts', 'r/main/a.ts', 'r/main/b.ts', 'r/hold.ts']);
    const at = (s: string) => source.indexOf(s);
    expect(at("main.get('/static'")).toBeLessThan(at("r.get('/a'"));
    expect(at("r.get('/a'")).toBeLessThan(at("r.get('/b'"));
    expect(at("r.get('/b'")).toBeLessThan(at("main.get('/:docNo'"));
    expect(at("main.get('/:docNo'")).toBeLessThan(at('r.patch(PATHS[d]'));
  });

  test('a commented-out call and a locally declared function add nothing', () => {
    const { files } = expandRouterFamily('r/main.ts', readTree);
    expect(files).not.toContain('r/main/ghost.ts');
    expect(files).toHaveLength(4);
  });

  test('a call it cannot resolve throws instead of reading less', () => {
    const broken = { ...tree, 'r/main.ts': `${tree['r/main.ts']}\nregisterMissingRoutes(main);` };
    expect(() => expandRouterFamily('r/main.ts', (k) => broken[k] ?? null)).toThrow(/registerMissingRoutes/);
    const unreadable = { ...tree, 'r/main.ts': `import { registerCRoutes } from './gone';\n${tree['r/main.ts']}\nregisterCRoutes(main);` };
    expect(() => expandRouterFamily('r/main.ts', (k) => unreadable[k] ?? null)).toThrow(/'\.\/gone'/);
  });
});

describe('soRouterSource', () => {
  test('starts with the router file and follows its register/mount calls', () => {
    const files = soRouterFiles();
    expect(files[0]).toBe('src/scm/routes/mfg-sales-orders.ts');
    expect(files).toContain('src/scm/routes/document-hold-routes.ts');
  });

  test('is exactly the family files, every line of each in its own order, with nothing else', () => {
    const lines = soRouterSource().split('\n');
    const files = soRouterFiles();
    expect(lines.length).toBe(files.reduce((n, f) => n + read(f).split('\n').length, 0));
    for (const f of files) {
      let at = 0;
      for (const line of read(f).split('\n')) {
        while (at < lines.length && lines[at] !== line) at++;
        expect(at, `${f} is not wholly inside soRouterSource() in order`).toBeLessThan(lines.length);
        at++;
      }
    }
    const holdAt = lines.findIndex((l) => l.startsWith("mountHoldRoute(mfgSalesOrders, 'so');"));
    expect(lines.slice(holdAt + 1, holdAt + 1 + read('src/scm/routes/document-hold-routes.ts').split('\n').length).join('\n'))
      .toBe(read('src/scm/routes/document-hold-routes.ts'));
  });

  test('every topic file under routes/mfg-sales-orders/ is registered, so none is read by nothing', () => {
    const dir = path.join(backendRoot, 'src/scm/routes/mfg-sales-orders');
    const onDisk = fs.existsSync(dir)
      ? fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .map((f) => `src/scm/routes/mfg-sales-orders/${f.split(path.sep).join('/')}`)
      : [];
    for (const f of onDisk) expect(soRouterFiles(), `${f} exists but no register call reaches it`).toContain(f);
  });
});
