/* The Sales Order router's source, as one string, for tests that assert a guard
   is (or is not) written into it.

   WHY A HELPER. mfg-sales-orders.ts is being split: handler blocks move into
   routes/mfg-sales-orders/<topic>.ts and are registered by a
   `register<Topic>Routes(mfgSalesOrders)` call at the spot they left. A test
   that `?raw`-imports mfg-sales-orders.ts alone would then stop seeing the
   moved code — a presence assertion fails loudly, but an ABSENCE assertion
   ("the router never does X") goes on passing over code it can no longer read.

   What this returns is the router file with the file behind each
   register/mount call inlined right after the call (scripts/lib/router-family.mjs),
   so the text keeps registration order and a moved block sits where it was.
   Today that is mfg-sales-orders.ts plus document-hold-routes.ts (the
   `mountHoldRoute(mfgSalesOrders, 'so')` call).

   `?raw` globs, not node:fs, so the same helper works in the light project, the
   workerd pool and tests-node. A family file outside the globs below makes the
   import THROW, naming the file — widen the glob, never catch it. */
import { expandRouterFamily } from '../../scripts/lib/router-family.mjs';

declare global {
  interface ImportMeta {
    glob(
      patterns: string | string[],
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

const SOURCES = import.meta.glob(
  [
    '../../src/scm/routes/mfg-sales-orders.ts',
    '../../src/scm/routes/mfg-sales-orders/**/*.ts',
    '../../src/scm/routes/*-routes.ts',
    '!../../src/scm/routes/**/*.test.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
);

const ENTRY = '../../src/scm/routes/mfg-sales-orders.ts';
const family = expandRouterFamily(ENTRY, (key: string) => SOURCES[key] ?? null);

/** mfg-sales-orders.ts with every register/mount call's file inlined at the call. */
export function soRouterSource(): string {
  return family.source;
}

const repoRelative = (key: string) => key.replace(/^(?:\.\.\/)+/, '');

/** The files soRouterSource() was built from, router file first, as `src/scm/routes/...`. */
export function soRouterFiles(): readonly string[] {
  return family.files.map(repoRelative);
}

/** Line `n` (1-based) of soRouterSource(), as the real `src/scm/routes/<file>:<line>` - for failure messages. */
export function soRouterLineOrigin(n: number): string {
  const origin = family.origins[n - 1];
  return origin ? `${repoRelative(origin.file)}:${origin.line}` : `<line ${n} is past the end>`;
}
