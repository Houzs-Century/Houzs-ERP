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

/** The SCM document pages that spell a status themselves, and which document
 *  vocabulary each one is spelling. Pages outside the SCM document set
 *  (Overview, SystemHealth, team, MerchantRecon, ServiceCases, SupplierDetail)
 *  are NOT here: they carry their own unrelated vocabularies, and sweeping them
 *  in would be the same over-reach this file exists to avoid. */
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

/* COLLAPSED — these six no longer declare a label of their own, so they are off
   the list above by the rule this file states: the list says how much of the
   root fix is LEFT. They were chosen by measurement, not by reading: each one
   renders the byte-identical string through `statusLabel(docType, STATUS)` that
   it used to hand-write. Every page still listed above would change at least one
   word on screen, which is a decision and not a refactor.

   GoodsReceivedListV2 · GoodsReceivedDetailV2 · PurchaseReturnsListV2
   PurchaseReturnDetailV2 · StockTakesListV2 · StockTransfersListV2 */

/* The words those six surfaces showed BEFORE the collapse, transcribed from the
   maps this PR deleted (read the diff, not this comment, if you doubt one).
   They now come from status-pill.ts, so this table is what fails if a later edit
   to the canonical map silently re-words a screen the owner already signed off.

   `pr` DRAFT is deliberately not in the canonical map and resolves through
   statusLabel's humanise fallback; it is listed here because what a user reads
   is the point, not which branch produced it. */
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
  ['stockTake', 'POSTED', 'Confirmed'],
  ['stockTake', 'CANCELLED', 'Cancelled'],
  ['stockTransfer', 'POSTED', 'Confirmed'],
  ['stockTransfer', 'CANCELLED', 'Cancelled'],
];

/* DELIBERATE differences — a page that says something else ON PURPOSE, with the
   reason and its authority. Every entry here is a decision somebody made, not a
   miss; sweeping them into agreement would UNDO those decisions, which is the
   exact over-reach that cost a production incident on 2026-09-13
   (docs/option-pool-clear-coe.md).

   The key is `<file>::<STATUS>`. Adding one means writing why. */
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

/** `DRAFT: { tone: "warning", label: "Draft", … }` and the lowercase-key form
 *  `posted: { tone: "success", label: "Confirmed" … }` both occur. */
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
    /* A page that stops declaring its own map is GOOD news — it means somebody
       collapsed it onto status-pill.ts. Remove it from PAGES in that same PR,
       so this list always says how much of the root fix is left. */
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
    /* A failure here is NOT a licence to edit the expected word. It means a
       screen the owner already reads changed wording — go and get that decided,
       the way the DELIBERATE list above records the ones that were. */
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
    /* The collapsed pages answer an unlisted status with its RAW value. That only
       survives if this helper does not quietly add the whole canonical vocabulary. */
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
      /* statusVocabulary returns an ARRAY of keys. The first draft of this
         test wrote `key in vocab`, which tests ARRAY INDICES — so every status
         fell into `unknown` and the suite passed having compared nothing. A
         verdict computed over nothing must never read as a pass (CLAUDE.md);
         the assertion below is what makes that impossible now. */
      const vocab = statusVocabulary(docType);
      if (!vocab.includes(key)) { unknown.push(`${rel}: ${e.status} = "${e.label}"`); continue; }
      const canonical = statusLabel(docType, key);
      if (canonical.toLowerCase() === e.label.toLowerCase()) continue;
      if (DELIBERATE.has(`${rel}::${key}`)) { deliberate.push(`${rel}::${key}`); continue; }
      disagreements.push(`${rel}: ${key} reads "${e.label}" here, "${canonical}" in status-pill.ts`);
    }
  }

  it('actually compared something — a scan that matched nothing must not pass', () => {
    /* The guard on the guard. Without it, one wrong membership test silently
       turns this whole file into a no-op that reports green. */
    const compared = PAGES.reduce((n, [rel, docType]) => n + parseLocalMap(read(rel))
      .filter((e) => statusVocabulary(docType).includes(e.status.toUpperCase())).length, 0);
    expect(compared).toBeGreaterThan(40);
  });

  it('every status a page names matches the canonical label', () => {
    expect(disagreements).toEqual([]);
  });

  it('every recorded DELIBERATE difference is still real — the list cannot rot', () => {
    /* An entry that no longer differs is a page somebody fixed; leaving it here
       would waive a future regression on that exact status. Same failure mode as
       an exemption list nobody re-checks. */
    const stale = [...DELIBERATE.keys()].filter((k) => !deliberate.includes(k));
    expect(stale, 'these no longer differ — delete them from DELIBERATE').toEqual([]);
  });

  it('reports the statuses no canonical vocabulary holds, without failing on them', () => {
    /* These are a page's own bucket keys (all / open / partial …) and statuses
       the shared map has never been taught. Reported so the count is visible;
       NOT failed, because adding a canonical entry to silence a test is
       inventing the evidence the test exists to check. */
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
    /* Proof the regex still matches the shape it exists for. If every page is
       collapsed one day this assertion is the one to change, on purpose. */
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
      /* `in`, not a truthiness check on the lookup: the unclassified test above
         owns that failure, and a Record index is typed as always present. */
      if (!(rel in STAGE_MAP_DOC)) continue;
      const docType = STAGE_MAP_DOC[rel];
      for (const e of parseStageMap(read(rel)) ?? []) {
        if (!statusVocabulary(docType).includes(e.status)) continue;
        const canonical = statusLabel(docType, e.status);
        /* Case-insensitive, like the object-map scan above: "Partially received"
           against "Partially Received" is a separate, owner-visible decision. */
        if (canonical.toLowerCase() !== e.label.toLowerCase()) {
          wrong.push(`${rel}: badge ${e.status} reads "${e.label}", status-pill.ts says "${canonical}"`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/* The phone's document header. Every SCM document module must name the canonical
   vocabulary its pill reads, so the word comes from status-pill.ts and not from
   title-casing the stored value. Parsed from source because MobileModuleDetail is
   one 2,000-line screen with no seam to render a single header through. */
const MOBILE_MODULE_DOC: Record<string, StatusDocType | null> = {
  'delivery-orders-mfg': 'do',
  'sales-invoices': 'si',
  grns: 'grn',
  'mfg-purchase-orders': 'po',
  'purchase-invoices': 'pi',
  'purchase-returns': 'pr',
  'delivery-returns': 'dr',
  /* No canonical map exists for the consignment documents, and the owner kept
     their own words (consignment IN_PRODUCTION reads "Proceed", 2026-09-13), so
     their pill humanises the stored value exactly as before. */
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
