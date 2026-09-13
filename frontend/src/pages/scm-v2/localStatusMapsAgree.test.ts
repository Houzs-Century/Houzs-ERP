/* EVERY PAGE THAT SPELLS A STATUS ITSELF MUST SPELL IT THE SAME WAY.
 *
 * `docs/modules/document-status-vocabulary.md` records that SIXTEEN list and
 * detail pages declare their own `{ tone, label }` map instead of reading
 * `status-pill.ts`, and calls that root fix OPEN. On 2026-09-13 that gap
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
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { statusLabel, statusVocabulary, type StatusDocType } from '../../vendor/scm/lib/status-pill';

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
  ['pages/scm-v2/GoodsReceivedListV2.tsx', 'grn'],
  ['pages/scm-v2/GoodsReceivedDetailV2.tsx', 'grn'],
  ['pages/scm-v2/PurchaseInvoicesListV2.tsx', 'pi'],
  ['pages/scm-v2/PurchaseInvoiceDetailV2.tsx', 'pi'],
  ['pages/scm-v2/PurchaseReturnsListV2.tsx', 'pr'],
  ['pages/scm-v2/PurchaseReturnDetailV2.tsx', 'pr'],
  ['pages/scm-v2/SalesInvoicesListV2.tsx', 'si'],
  ['pages/scm-v2/SalesInvoiceDetailV2.tsx', 'si'],
  ['pages/scm-v2/SalesOrderDetailV2.tsx', 'so'],
  ['pages/scm-v2/so-list-status.ts', 'so'],
  ['pages/scm-v2/DeliveryOrderDetailV2.tsx', 'do'],
  ['pages/scm-v2/do-list-status.ts', 'do'],
  ['pages/scm-v2/DeliveryReturnsListV2.tsx', 'dr'],
  ['pages/scm-v2/DeliveryReturnDetailV2.tsx', 'dr'],
  ['pages/scm-v2/StockTakesListV2.tsx', 'stockTake'],
  ['pages/scm-v2/StockTransfersListV2.tsx', 'stockTransfer'],
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
  ['pages/scm-v2/so-list-status.ts::IN_PRODUCTION',
   'OPEN — the owner decides. The list TAB says "In Production" and the pill says '
   + '"Proceed"; both are his words from different days. One rung with two words '
   + 'is the defect he reported on 2026-09-13, so this is recorded rather than '
   + 'silently aligned: aligning it would change what he reads without his say.'],
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
