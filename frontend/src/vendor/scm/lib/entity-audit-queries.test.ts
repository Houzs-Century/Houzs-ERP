/* The frontend's AuditEntityType is a HAND-COPY of the backend's ENTITY_TYPES,
   and on 2026-09-13 it was five names behind: the backend had been writing
   PURCHASE_ORDER, PURCHASE_INVOICE, SALES_INVOICE, DELIVERY_ORDER and
   PURCHASE_RETURN rows for months, and no screen could ask for any of them
   because the type they had to be named with did not exist.

   Nothing failed. The endpoint was right, the rows were there, and the only
   broken part was a list one directory tree over — so the four documents simply
   had no change history, while the History button on three of them navigated to
   a URL parameter nothing reads.

   This test makes the two lists ONE list in practice: it reads the backend's
   own source and fails the moment a name is added on one side only. */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AUDIT_ENTITY_TYPES } from './entity-audit-queries';

/* Found by walking UP from the working directory rather than by a fixed
   relative path. Two reasons, both load-bearing: this file is reached through a
   vite ALIAS, so `import.meta.url` is not a file URL here and the usual
   `dirname(fileURLToPath(import.meta.url))` idiom throws; and the suite is run
   both from the repo root and from `frontend/` (CI uses
   `working-directory: frontend`), so no single `../` count is right in both. */
const REL = 'backend/src/scm/lib/entity-audit.ts';
const findBackend = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, REL);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`${REL} not found above ${process.cwd()} — this test must never pass on an empty read`);
};

/** The names inside `export const ENTITY_TYPES = [ ... ] as const;`. */
const backendEntityTypes = (): string[] => {
  const src = readFileSync(findBackend(), 'utf8');
  const block = /export const ENTITY_TYPES = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error('ENTITY_TYPES block not found in entity-audit.ts — this test is reading the wrong file');
  /* Comments inside the block name other types in prose, so match only the
     quoted entries, and only those on their own line. */
  return [...block[1].matchAll(/^\s*'([A-Z_]+)',/gm)].map((m) => m[1]);
};

describe('AuditEntityType mirrors the backend', () => {
  it('reads a non-empty list out of the backend, so a silent miss cannot pass', () => {
    expect(backendEntityTypes().length).toBeGreaterThan(5);
  });

  it('carries exactly the names the backend records — no more, no fewer', () => {
    expect([...AUDIT_ENTITY_TYPES].sort()).toEqual(backendEntityTypes().sort());
  });

  it('covers the four documents whose history was unreachable until 2026-09-13', () => {
    for (const t of ['PURCHASE_ORDER', 'PURCHASE_INVOICE', 'SALES_INVOICE', 'DELIVERY_ORDER']) {
      expect(AUDIT_ENTITY_TYPES).toContain(t);
    }
  });
});
