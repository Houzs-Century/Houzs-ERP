import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AUDIT_ENTITY_TYPES } from './entity-audit-queries';

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

const backendEntityTypes = (): string[] => {
  const src = readFileSync(findBackend(), 'utf8');
  const block = /export const ENTITY_TYPES = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error('ENTITY_TYPES block not found in entity-audit.ts — this test is reading the wrong file');
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
