/* EVERY PAGE THAT SPELLS A STATUS ITSELF MUST SPELL IT THE SAME WAY.
 *
 * `docs/modules/document-status-vocabulary.md` records that list and detail
 * pages declare their own `{ tone, label }` map instead of reading
 * `status-pill.ts`, and calls that root fix OPEN. (It said "sixteen"; this list
 * enumerated eighteen, and a count lives in the list, not in prose.) On 2026-09-13 that gap
 * produced a visible defect: the Purchase Orders list's filter TAB said
 * SUBMITTED beside a status PILL that said Confirmed, and the Goods Received
 * tab said CONFIRMED — one rung, three words on one screen.
 *
 * The owner's question afterwards was the right one:
 * 「所以还有什么重复的规则呢？为什么那么多 bugs 呢？一个功能」
 *
 * THIS TEST IS THE GUARD, NOT THE REFACTOR. Collapsing sixteen pages onto the
 * shared map in one change is a wide, risky diff, and a wide change made on
 * reasoning rather than measurement is exactly what went wrong earlier that day
 * (docs/option-pool-clear-coe.md). So the disagreement is pinned FIRST and the
 * pages can be collapsed one at a time behind a guard that is already green.
 *
 * WHAT IT DOES. For each page below it parses the local map's
 * `STATUS_VALUE: { … label: "X" … }` entries and compares X against
 * `statusLabel(docType, STATUS_VALUE)` — the canonical answer. A page may hold
 * a status the canonical map has never heard of (its own bucket vocabulary);
 * that is reported as UNKNOWN and not failed, because inventing a canonical
 * entry to make a test pass is forging the evidence.
 *
 * SIX OF THE EIGHTEEN ARE COLLAPSED (2026-09-13) and are therefore no longer in
 * PAGES. That removal costs something the list itself cannot give back: a page
 * that stops declaring a map also stops being watched here. `COLLAPSED_WORDS`
 * below is what replaces that watch — the exact words those six surfaces showed
 * BEFORE the collapse, asserted against the canonical map they now read. It is
 * the durable form of the measurement that chose them.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { statusLabel, statusVocabulary, withStatusLabels, type StatusDocType } from '../../vendor/scm/lib/status-pill';

const findSrc = (): string => {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, 'frontend/src');
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`frontend/src not found above ${process.cwd()} — this test must never pass on an empty read`);
};
const SRC = findSrc();

const PAGES: ReadonlyArray<readonly [rel: string, docType: StatusDocType]> = [
  ['pages/scm-v2/PurchaseOrdersListV2.tsx', 'po'],
  ['pages/scm-v2/PurchaseOrderDetailV2.tsx', 'po'],
  ['pages/scm-v2/PurchaseInvoicesListV2.tsx', 'pi'],
  ['pages/scm-v2/PurchaseInvoiceDetailV2.tsx', 'pi'],
  ['pages/scm-v2/SalesInvoicesListV2.tsx', 'si'],
  ['pages/scm-v2/SalesInvoiceDetailV2.tsx', 'si'],
  ['pages/scm-v2/SalesOrderDetailV2.tsx', 'so'],
  ['pages/scm-v2/so-list-status.ts', 'so'],
  ['pages/scm-v2/DeliveryOrderDetailV2.tsx', 'do'],
  ['pages/scm-v2/do-list-status.ts', 'do'],
  ['pages/scm-v2/DeliveryReturnsListV2.tsx', 'dr'],
  ['pages/scm-v2/DeliveryReturnDetailV2.tsx', 'dr'],
];


const COLLAPSED_WORDS: ReadonlyArray<readonly [docType: StatusDocType, status: string, word: string]> = [
  ['grn', 'DRAFT', 'Draft'],
  ['grn', 'POSTED', 'Submitted'],
  ['grn', 'CLOSED', 'Closed'],
  ['grn', 'CANCELLED', 'Cancelled'],
  ['grn', 'ON_HOLD', 'On Hold'],
  ['pr', 'DRAFT', 'Draft'],
  ['pr', 'POSTED', 'Confirmed'],
  ['pr', 'COMPLETED', 'Completed'],
  ['pr', 'CANCELLED', 'Cancelled'],
  ['stockTake', 'OPEN', 'Open'],
  ['stockTake', 'PENDING_APPROVAL', 'Pending Approval'],
  ['stockTake', 'POSTED', 'Confirmed'],
  ['stockTake', 'CANCELLED', 'Cancelled'],
  ['stockTransfer', 'POSTED', 'Confirmed'],
  ['stockTransfer', 'CANCELLED', 'Cancelled'],
];

const DELIBERATE = new Map<string, string>([
  ['pages/scm-v2/do-list-status.ts::SIGNED',
   'OWNER RULING 2026-08-21: SIGNED is merged into DELIVERED and gets no tab of '
   + 'its own, so the LIST says Delivered. The pill still says Signed because the '
   + 'document really is at that stored value. The file says so in its own header.'],
  ['pages/scm-v2/DeliveryReturnDetailV2.tsx::INSPECTED',
   'A NEXT-STEP vocabulary, not a status pill: this map carries a `blurb` beside '
   + 'each label and reads "Awaiting inspection" / "Ready to refund" / "Refunded" — '
   + 'it tells the operator what to DO, which is a different register from naming '
   + 'the state.'],
  ['pages/scm-v2/DeliveryReturnDetailV2.tsx::CANCELLED',
   'Same next-step vocabulary — "Closed" is what the hero strip says when the '
   + 'return is over, beside its blurb. Not the status pill.'],
]);

type Entry = { status: string; label: string };

const parseLocalMap = (source: string): Entry[] => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const out: Entry[] = [];
  const re = /(^|[\s{,])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{[^{}]*?label:\s*["'`]([^"'`]+)["'`][^{}]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ status: m[2], label: m[3] });
  return out;
};

const read = (rel: string): string => {
  const p = resolve(SRC, rel);
  if (!existsSync(p)) throw new Error(`${rel} is gone — update this list rather than deleting the case`);
  return readFileSync(p, 'utf8');
};

describe('the scan is reading real maps', () => {
  it('finds status entries in every page listed', () => {
    const empty = PAGES.filter(([rel]) => parseLocalMap(read(rel)).length === 0).map(([rel]) => rel);
    expect(empty, 'these pages no longer declare a local map — remove them from PAGES').toEqual([]);
  });

  it('the canonical vocabularies are non-empty, so a comparison means something', () => {
    for (const docType of new Set(PAGES.map(([, d]) => d))) {
      expect(statusVocabulary(docType).length, docType).toBeGreaterThan(1);
    }
  });
});

describe('the six collapsed pages still read the words they read before', () => {
  it('every pinned word is what status-pill.ts answers today', () => {
    const moved = COLLAPSED_WORDS
      .filter(([docType, status, word]) => statusLabel(docType, status) !== word)
      .map(([docType, status, word]) => `${docType}.${status}: was "${word}", status-pill.ts now says "${statusLabel(docType, status)}"`);
    expect(moved).toEqual([]);
  });

  it('no collapsed page declares a status map any more — the collapse cannot silently revert', () => {
    const COLLAPSED = [
      'pages/scm-v2/GoodsReceivedListV2.tsx',
      'pages/scm-v2/GoodsReceivedDetailV2.tsx',
      'pages/scm-v2/PurchaseReturnsListV2.tsx',
      'pages/scm-v2/PurchaseReturnDetailV2.tsx',
      'pages/scm-v2/StockTakesListV2.tsx',
      'pages/scm-v2/StockTransfersListV2.tsx',
    ];
    const relapsed = COLLAPSED.filter((rel) => parseLocalMap(read(rel)).length > 0);
    expect(relapsed, 'these declare a local label again — put them back in PAGES or undo the relapse').toEqual([]);
  });
});

describe('withStatusLabels — how a collapsed page gets its word', () => {
  const own = {
    POSTED: { tone: 'success', bucket: 'posted' },
    DRAFT: { tone: 'warning', bucket: 'draft' },
  } as const;
  const withLabels = withStatusLabels('grn', own);

  it('attaches exactly the canonical label, keyed by the stored status', () => {
    expect(withLabels.POSTED.label).toBe(statusLabel('grn', 'POSTED'));
    expect(withLabels.DRAFT.label).toBe(statusLabel('grn', 'DRAFT'));
  });

  it("keeps everything that is the page's own — the tone and the bucket are untouched", () => {
    expect(withLabels.POSTED).toMatchObject({ tone: 'success', bucket: 'posted' });
    expect(withLabels.DRAFT).toMatchObject({ tone: 'warning', bucket: 'draft' });
  });

  it("adds no status the page did not list, so the page's own fallback still decides an unknown one", () => {
    expect(Object.keys(withLabels).sort()).toEqual(['DRAFT', 'POSTED']);
    expect(withLabels.CANCELLED).toBeUndefined();
  });
});

describe('no page spells a status differently from status-pill.ts', () => {
  const disagreements: string[] = [];
  const deliberate: string[] = [];
  const unknown: string[] = [];

  for (const [rel, docType] of PAGES) {
    for (const e of parseLocalMap(read(rel))) {
      const key = e.status.toUpperCase();
      const vocab = statusVocabulary(docType);
      if (!vocab.includes(key)) { unknown.push(`${rel}: ${e.status} = "${e.label}"`); continue; }
      const canonical = statusLabel(docType, key);
      if (canonical.toLowerCase() === e.label.toLowerCase()) continue;
      if (DELIBERATE.has(`${rel}::${key}`)) { deliberate.push(`${rel}::${key}`); continue; }
      disagreements.push(`${rel}: ${key} reads "${e.label}" here, "${canonical}" in status-pill.ts`);
    }
  }

  it('actually compared something — a scan that matched nothing must not pass', () => {
    const compared = PAGES.reduce((n, [rel, docType]) => n + parseLocalMap(read(rel))
      .filter((e) => statusVocabulary(docType).includes(e.status.toUpperCase())).length, 0);
    expect(compared).toBeGreaterThan(40);
  });

  it('every status a page names matches the canonical label', () => {
    expect(disagreements).toEqual([]);
  });

  it('every recorded DELIBERATE difference is still real — the list cannot rot', () => {
    const stale = [...DELIBERATE.keys()].filter((k) => !deliberate.includes(k));
    expect(stale, 'these no longer differ — delete them from DELIBERATE').toEqual([]);
  });

  it('reports the statuses no canonical vocabulary holds, without failing on them', () => {
    expect(Array.isArray(unknown)).toBe(true);
    if (unknown.length) console.log(`[status-map scan] ${unknown.length} entr(ies) outside the canonical vocabularies (informational)`);
  });
});

/* THE HEADER BADGE — a second family of copies the scans above could not see.
 *
 * Found 2026-09-13 while collapsing the six pages (docs/bugs/0866). A detail
 * page's header <Badge> did not read the `{ tone, label }` map at all: it read a
 * FLAT `STAGE_LABEL: Record<string, string>`, `KEY: "Word"` with no object
 * around it, so parseLocalMap never matched it — and the Goods Received and
 * Purchase Invoice badges said "Posted", the Sales Invoice badge "Sent", where
 * the owner ruled 「PI、SI、GR、PO、SO 都要改成 submitted」 (2026-09-12).
 *
 * The phone had the same fault by a different road: MobileModuleDetail's
 * StatusPill title-cased the RAW stored value, so a delivery order at LOADED read
 * "Loaded" — the word the owner gave the NEXT rung (DISPATCHED, 2026-08-26).
 *
 * So this block finds its files by SHAPE across pages/scm-v2 rather than from a
 * hand list: a new page that declares a flat stage map is scanned the day it is
 * written, and one this block has not been told the document type of FAILS
 * instead of being skipped. */
const STAGE_MAP_DOC: Record<string, StatusDocType> = {
  'pages/scm-v2/PurchaseOrderDetailV2.tsx': 'po',
  'pages/scm-v2/DeliveryOrderDetailV2.tsx': 'do',
  'pages/scm-v2/DeliveryReturnDetailV2.tsx': 'dr',
  'pages/scm-v2/GoodsReceivedDetailV2.tsx': 'grn',
  'pages/scm-v2/PurchaseInvoiceDetailV2.tsx': 'pi',
  'pages/scm-v2/SalesInvoiceDetailV2.tsx': 'si',
  'pages/scm-v2/PurchaseReturnDetailV2.tsx': 'pr',
};

const parseStageMap = (source: string): Entry[] | null => {
  const text = source.replace(/\r/g, '');
  const m = /const STAGE_LABEL\s*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/.exec(text);
  if (!m) return null;
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*["'`]([^"'`]+)["'`]/g)].map((x) => ({ status: x[1], label: x[2] }));
};

const scmV2Files = (): string[] => {
  const dir = resolve(SRC, 'pages/scm-v2');
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => `pages/scm-v2/${f}`);
};

describe('the header badge spells a status the way status-pill.ts does', () => {
  const declaring = scmV2Files().filter((rel) => parseStageMap(read(rel)) !== null);

  it('the shape scan finds real flat stage maps — it cannot pass by matching nothing', () => {
    expect(declaring.length).toBeGreaterThan(0);
    const entries = declaring.reduce((n, rel) => n + (parseStageMap(read(rel)) ?? []).length, 0);
    expect(entries).toBeGreaterThan(10);
  });

  it('every page declaring a flat stage map is one this guard knows the document type of', () => {
    const unclassified = declaring.filter((rel) => !(rel in STAGE_MAP_DOC));
    expect(unclassified, 'add these to STAGE_MAP_DOC with their document type').toEqual([]);
  });

  it('no badge word disagrees with status-pill.ts', () => {
    const wrong: string[] = [];
    for (const rel of declaring) {
      if (!(rel in STAGE_MAP_DOC)) continue;
      const docType = STAGE_MAP_DOC[rel];
      for (const e of parseStageMap(read(rel)) ?? []) {
        if (!statusVocabulary(docType).includes(e.status)) continue;
        const canonical = statusLabel(docType, e.status);
        if (canonical.toLowerCase() !== e.label.toLowerCase()) {
          wrong.push(`${rel}: badge ${e.status} reads "${e.label}", status-pill.ts says "${canonical}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

const MOBILE_MODULE_DOC: Record<string, StatusDocType | null> = {
  'delivery-orders-mfg': 'do',
  'sales-invoices': 'si',
  grns: 'grn',
  'mfg-purchase-orders': 'po',
  'purchase-invoices': 'pi',
  'purchase-returns': 'pr',
  'delivery-returns': 'dr',
  'consignment-orders': null,
  'consignment-notes': null,
  'consignment-returns': null,
  'purchase-consignment-orders': null,
  'purchase-consignment-receives': null,
  'purchase-consignment-returns': null,
};

describe('the phone document header reads its word from status-pill.ts', () => {
  const source = read('mobile/MobileModuleDetail.tsx').replace(/\r/g, '');
  const docModules = /const DOC_MODULES: Record<string, DocMap> = \{([\s\S]*?)\n\};/.exec(source);
  const block = docModules ? docModules[1] : '';
  const declared = new Map<string, string>();
  for (const m of block.matchAll(/\n {2}"?([a-z][a-z-]*)"?: \{\n([\s\S]*?)\n {2}\},/g)) {
    const doc = /\bstatusDoc: (null|["']([A-Za-z]+)["']),/.exec(m[2]);
    declared.set(m[1], doc ? doc[1].replace(/["']/g, '') : '<missing>');
  }

  it('the module scan found the document modules — it cannot pass on an empty read', () => {
    expect(declared.size).toBeGreaterThanOrEqual(Object.keys(MOBILE_MODULE_DOC).length);
  });

  it('every document module names the vocabulary this guard expects', () => {
    const got = Object.fromEntries([...declared].filter(([k]) => k in MOBILE_MODULE_DOC));
    const want = Object.fromEntries(Object.entries(MOBILE_MODULE_DOC).map(([k, v]) => [k, v ?? 'null']));
    expect(got).toEqual(want);
  });

  it('no document module on the phone is left unclassified', () => {
    expect([...declared.keys()].filter((k) => !(k in MOBILE_MODULE_DOC))).toEqual([]);
  });
});
