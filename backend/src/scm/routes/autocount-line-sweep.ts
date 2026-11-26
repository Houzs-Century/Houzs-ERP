/* ----------------------------------------------------------------------------
   POST /autocount-outbox/line-order-sweep — how many documents' lines still
   disagree with the ERP, measured over the WHOLE population.

   WHY IT EXISTS. Three migrated documents were found by the owner OPENING them
   one at a time: the lines in a different order from the ERP's, and on
   SO-013361 a line he had deleted still sitting in the book at Qty 0. After the
   third:

       「之后有问题吗？我不要每次都来 fix 啊」

   He chose to measure the population rather than keep fixing one at a time.
   Documents the ERP CREATES are laid down in the ERP's own order and an
   add/delete rebuilds the whole document, so they are right by construction —
   it is the MIGRATED ones, which the book wrote before the ERP ever saw them,
   that were never expected to match and that nothing has ever counted.

   READ-ONLY, ON BOTH SIDES. One SELECT on the account book
   (`/line-fingerprints`), a handful of paged SELECTs here. Nothing is written,
   no outbox row is made and no document is touched — the sweep says WHICH
   documents to rebuild; the rebuilding stays a separate, deliberate act.

   IT REUSES THE SEND'S OWN MACHINERY, and that is the whole reason to trust it:

     · `composeDetails` builds the expected code list, so a sofa's compartment
       lines collapse the way a real send collapses them;
     · `live()` drops a cancelled line the way a real send drops it;
     · `bindingsFor` resolves supplier codes with `material_kind`,
       `ac_item_code` before `supplier_sku`, and `is_main_supplier` first — a
       hand-written binding read here got all three wrong on the first attempt,
       which would have mis-stated real documents;
     · the line read is ordered `created_at` then `id`, which is what
       `inAcLineOrder` means by the ERP's line order.

   A second copy of any of those would drift, and the first thing it would do is
   report every sofa document as broken.

   ONE HOST CALL, AND BULK READS. `/doc-read` per document is ~2,700 round trips
   and `composeSoState` is ~7 database reads per document; either is far past
   what one Worker request survives (measured on this system: a whole-corpus
   pull answered 503 `Worker exceeded resource limits` in 39 seconds). So the
   book is asked once and this side reads in pages.
   -------------------------------------------------------------------------- */
import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { hasHouzsPerm } from '../lib/houzs-perms';
import { activeCompanyId } from '../lib/companyScope';
import { callAcRead } from '../../services/autocount-host-read';
import { acItemIndex } from '../../services/autocount-item-code';
import { composeDetails, live, type ErpLine } from '../../services/autocount-writeback';
import { bindingsFor } from '../lib/autocount-outbox';
import {
  bookCodesOf, compareLineOrder, summariseSweep,
  type BookFingerprint, type SweepRow,
} from '../lib/ac-line-order-sweep';

const SWEEP_KEYS = ['scm.autocount.read', 'settings.manage'] as const;

const PAGE = 1000;

const FAILING_CAP = 200;

const LINE_COLS = 'doc_no, item_code, item_group, description, description2, qty, unit_price_sen, variants, cancelled, created_at, id';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type Sb = any;

class PageReadError extends Error {}

async function readAllPages(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new PageReadError(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export const autocountLineSweepHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  if (!SWEEP_KEYS.some((k) => hasHouzsPerm(c, k))) {
    return c.json({
      error: 'forbidden',
      message: `Sweeping the account book reads it, so it is limited to ${SWEEP_KEYS.join(' or ')}.`,
    }, 403);
  }

  const sb = c.get('supabase') as Sb;
  const companyId = activeCompanyId(c);

  const read = await callAcRead(c.env, 'line_fingerprints', { Type: 'SO' });
  if (!read.ok) {
    return c.json({
      ok: false,
      error: read.error,
      message: 'The account book could not be read, so nothing was measured.',
    }, 502);
  }
  const fingerprints = Array.isArray(read.body?.docs) ? (read.body?.docs as BookFingerprint[]) : [];
  const book = new Map<string, BookFingerprint>();
  for (const f of fingerprints) book.set(String(f.DocNo).trim().toUpperCase(), f);

  let headers: Record<string, unknown>[];
  let lineRows: Record<string, unknown>[];
  try {
    headers = await readAllPages(() => sb.from('mfg_sales_orders')
      .select('doc_no, linked_ac_docno')
      .eq('company_id', companyId)
      .not('linked_ac_docno', 'is', null)
      .order('doc_no', { ascending: true }));
    const owned = new Set(headers.map((h) => String(h.doc_no ?? '')));
    lineRows = (await readAllPages(() => sb.from('mfg_sales_order_items')
      .select(LINE_COLS)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })))
      .filter((r) => owned.has(String(r.doc_no ?? '')));
  } catch (e) {
    if (e instanceof PageReadError) return c.json({ error: 'read_failed', reason: e.message }, 500);
    throw e;
  }

  const byDoc = new Map<string, Record<string, unknown>[]>();
  for (const r of lineRows) {
    const k = String(r.doc_no ?? '');
    const list = byDoc.get(k);
    if (list) list.push(r); else byDoc.set(k, [r]);
  }

  let bindings: Map<string, string>;
  try {
    bindings = await bindingsFor(sb, companyId,
      [...new Set(lineRows.map((r) => String(r.item_code ?? '')))]);
  } catch (e) {
    return c.json({ error: 'read_failed', reason: (e as Error).message }, 500);
  }

  const itemIndex = acItemIndex();

  const rows: SweepRow[] = headers.map((h) => {
    const docNo = String(h.doc_no ?? '');
    const bookDocNo = String(h.linked_ac_docno ?? docNo).trim().toUpperCase();
    const f = book.get(bookDocNo) ?? null;
    const lines = (byDoc.get(docNo) ?? []) as unknown as ErpLine[];
    let erpCodes: string[] | null;
    try {
      erpCodes = composeDetails(live(lines), { itemIndex, bindings }).details.map((d) => d.ItemCode);
    } catch {
      erpCodes = null;
    }
    return {
      docNo,
      verdict: compareLineOrder(f ? bookCodesOf(f) : null, erpCodes),
      bookLines: f ? f.Lines : null,
      erpLines: erpCodes ? erpCodes.length : null,
    };
  });

  return c.json({
    ok: true,
    docType: 'SO',
    bookDocuments: book.size,
    bookTruncated: read.body?.truncated === true,
    ...summariseSweep(rows, FAILING_CAP),
  });
};
