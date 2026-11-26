import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { DOCS, type HistoryDocType } from './DocumentHistoryDrawer';
import { AUDIT_ENTITY_TYPES } from '../../vendor/scm/lib/entity-audit-queries';

const repoFile = (rel: string): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`${rel} not found above ${process.cwd()} — this test must never pass on an empty read`);
};

const DOC_KEYS = Object.keys(DOCS) as HistoryDocType[];
const spec = (key: HistoryDocType) => DOCS[key].labels;

describe('the history drawer registry', () => {
  it('names only entity types the backend actually records', () => {
    for (const key of DOC_KEYS) expect(AUDIT_ENTITY_TYPES).toContain(key);
  });

  it('covers the four documents that had no readable history before 2026-09-13', () => {
    for (const key of ['PURCHASE_ORDER', 'PURCHASE_INVOICE', 'SALES_INVOICE', 'DELIVERY_ORDER']) {
      expect(DOC_KEYS).toContain(key);
    }
  });

  it('gives every document a status vocabulary the StatusPill knows', () => {
    const src = repoFile('frontend/src/vendor/scm/lib/status-pill.ts');
    const maps = /const MAPS: Record<StatusDocType, Record<string, Entry>> = \{([\s\S]*?)\};/.exec(src);
    expect(maps).not.toBeNull();
    const known = [...(maps as RegExpExecArray)[1].matchAll(/([A-Za-z]+):\s*[A-Z_]+/g)].map((m) => m[1]);
    expect(known.length).toBeGreaterThan(5);
    for (const key of DOC_KEYS) expect(known).toContain(DOCS[key].statusDocType);
  });

  it('gives every document a name and a non-empty vocabulary', () => {
    for (const key of DOC_KEYS) {
      const doc = DOCS[key];
      expect(doc.entityName.length).toBeGreaterThan(2);
      expect(Object.keys(doc.labels.actions).length).toBeGreaterThan(3);
      expect(Object.keys(doc.labels.fields).length).toBeGreaterThan(3);
    }
  });

  it('labels `status` on every document, because every document logs a status change', () => {
    for (const key of DOC_KEYS) expect(spec(key).fields.status).toBeTruthy();
  });

  it('renders money keys through the money formatter, not as raw sen', () => {
    for (const key of DOC_KEYS) {
      const money = spec(key).moneyFields;
      if (!spec(key).fields.lineTotalSen) continue;
      expect(money).toBeDefined();
      expect(money?.has('lineTotalSen')).toBe(true);
      expect(money?.has('unitPriceSen')).toBe(true);
    }
  });
});

describe('the document vocabularies match what their routes write', () => {
  const camelKeys = (src: string, constName: string): string[] => {
    const block = new RegExp(`const ${constName}[^=]*= \\[([\\s\\S]*?)\\n\\];`).exec(src);
    if (!block) throw new Error(`${constName} not found`);
    return [...block[1].matchAll(/\['([a-zA-Z0-9]+)',/g)].map((m) => m[1]);
  };

  const cases: Array<[HistoryDocType, string, string]> = [
    ['PURCHASE_ORDER', 'backend/src/scm/routes/mfg-purchase-orders.ts', 'PO_AUDIT_FIELDS'],
    ['SALES_INVOICE', 'backend/src/scm/routes/sales-invoices.ts', 'SI_AUDIT_FIELDS'],
    ['PURCHASE_INVOICE', 'backend/src/scm/lib/pi-audit-trail.ts', 'PI_AUDIT_FIELDS'],
    ['DELIVERY_ORDER', 'backend/src/scm/lib/do-audit-fields.ts', 'DO_AUDIT_FIELDS'],
  ];

  for (const [doc, file, constName] of cases) {
    it(`${doc} labels every header field its route diffs`, () => {
      const keys = camelKeys(repoFile(file), constName);
      expect(keys.length).toBeGreaterThan(3);
      const missing = keys.filter((k) => !DOCS[doc].labels.fields[k]);
      expect(missing).toEqual([]);
    });
  }
});
