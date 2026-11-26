// /document-flow — the SAP-Business-One-style "Relationship Map".
//
// Given ANY document (SO / DO / SI / AR-payment / PO / GRN / PI) it resolves the
// Sales Order(s) that document descends from, then expands the WHOLE family in
// both directions:
//
//   sales chain:     SO ──▶ DO ──▶ Sales Invoice ──▶ AR Payment
//                            └──▶ Delivery Return (goods sent back)
//   purchase chain:  SO ──▶ PO ──▶ GRN ──▶ Purchase Invoice
//                                   └──▶ Purchase Return (goods sent back)
//
// and returns a flat { nodes, edges } graph the frontend lays out in fixed
// stage-columns. Every edge carries a `kind` so the UI can colour it:
//   full     — the child took 100% of the qty it referenced       (blue)
//   partial  — the child took only part                           (red)
//   value    — SO ▶ PO, a value/qty purchase transfer             (orange)
//   payment  — Sales Invoice ▶ AR Payment                         (green)
//
// Every edge ALSO carries `linkage` (2026-08-07, the owner's "soft until DO,
// hard from DO" decision — docs/modules/document-traceability.md §Decision):
//   chain      — a vertical execution FK (SO▶DO▶SI▶payment, DO▶DR, PO▶GRN▶PI,
//                GRN▶PR, the consignment chains) — anchored history, solid.
//   provenance — the SO▶PO raise-link (stored so_item_id / "From SOs:" note).
//                It records WHY WE BOUGHT and binds no execution — muted.
// The third kind the map renders, the FLOATING pre-DO PO↔SO pairing, is
// deliberately NOT computed here: the client assembles it from the
// /po-so-coverage response it already holds (source:'mrp' assignments), so the
// map adds ZERO backend load (owner constraint — no computeMrp call on this
// route, ever). `linkage` is ADDITIVE; consumers that ignore it are unaffected.
//
// All linkage columns are the real FKs (confirmed against the scm schema):
//   delivery_orders.so_doc_no / delivery_order_items.so_item_id
//   sales_invoices.so_doc_no / .delivery_order_id / sales_invoice_items.do_item_id
//   sales_invoice_payments.sales_invoice_id
//   purchase_order_items.so_item_id
//   grns.purchase_order_id / grn_items.purchase_order_item_id
//   purchase_invoices.grn_id / purchase_invoice_items.grn_item_id
//
// Houzs adaptation: ported verbatim from 2990's apps/api/src/routes/document-flow.ts.
// Same plumbing as the sibling SCM routes — supabaseAuth bridge + scm-scoped
// service client via c.get('supabase'); every table ref already resolves against
// the `scm` schema. Read-only: this route never writes. Mounted at '/document-flow'.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { supabaseAuth } from '../middleware/auth';
import { activeCompanyId, scopeToCompany } from '../lib/companyScope';
import { parseProvenanceNote } from '../shared/transfer-vocabulary';
import { chunkIn, paginateAll } from '../lib/paginate-all';
import type { Env, Variables } from '../env';
import { pgrestIn } from '../lib/pgrest-in-list';
import { fmtSen } from '../shared/format';
import { readFailure } from '../lib/read-failure';

export const documentFlow = new Hono<{ Bindings: Env; Variables: Variables }>();
documentFlow.use('*', supabaseAuth);

type NodeType =
  | 'so' | 'do' | 'si' | 'payment' | 'po' | 'grn' | 'pi' | 'dr' | 'pr'
  | 'cso' | 'cdo' | 'cdr' | 'pco' | 'pcr' | 'pcrn';
type EdgeKind = 'full' | 'partial' | 'value' | 'payment';
type EdgeLinkage = 'chain' | 'provenance';

const CONSIGNMENT_TYPES: NodeType[] = ['cso', 'cdo', 'cdr', 'pco', 'pcr', 'pcrn'];

type FlowNode = {
  key: string;
  type: NodeType;
  id: string;
  label: string;
  status: string | null;
  isAnchor: boolean;
};
type FlowEdge = { from: string; to: string; kind: EdgeKind; linkage: EdgeLinkage };

const keyOf = (type: NodeType, id: string) => `${type}:${id}`;
const cover = (childQty: number, parentQty: number): EdgeKind =>
  parentQty > 0 && childQty + 1e-9 < parentQty ? 'partial' : 'full';
const uniq = (xs: Array<string | null | undefined>) =>
  [...new Set(xs.filter((x): x is string => !!x))];

export function derivePoGrnCoverage(
  poItemQty: ReadonlyMap<string, { poId: string; qty: number }>,
  grnLines: ReadonlyArray<{ grn_id: string; purchase_order_item_id: string | null; qty: number }>,
): Map<string, { childQty: number; parentQty: number }> {
  const agg = new Map<string, { childQty: number; parentItems: Set<string> }>();
  for (const l of grnLines) {
    const itemId = l.purchase_order_item_id;
    if (!itemId || !l.grn_id) continue;
    const pm = poItemQty.get(itemId);
    if (!pm) continue;
    const k = `${pm.poId}|${l.grn_id}`;
    const a = agg.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
    a.childQty += Number(l.qty ?? 0);
    a.parentItems.add(itemId);
    agg.set(k, a);
  }
  const out = new Map<string, { childQty: number; parentQty: number }>();
  for (const [k, a] of agg) {
    const parentQty = [...a.parentItems].reduce((s, pi) => s + (poItemQty.get(pi)?.qty ?? 0), 0);
    out.set(k, { childQty: a.childQty, parentQty });
  }
  return out;
}

const stripCompanyPrefix = (docNo: string): string => docNo.replace(/^\d+-/, '');

const DOC_TOKEN_CHAR = /[A-Za-z0-9-]/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* EXTRACT the source SO doc numbers a PO's provenance note records — the
   reverse of noteMentionsToken (membership) for callers that need the tokens
   themselves (e.g. resolving a single PO's origin SO(s) without scanning every
   company SO).

   The note FORMAT no longer lives here. It moved to
   `src/scm/shared/transfer-vocabulary.ts` on 2026-08-18, because it was never
   only a backend concern: the frontend map, the printed PO and three .mjs
   repair scripts each carried their own copy of this regex, and the label the
   writer stamps has to be the SAME sentence the transfer BUTTON says (#2370's
   rule). One home, four trees.

   What that module guarantees, and the reason this is a re-export rather than a
   second parser: it accepts the CURRENT label AND both pre-2026-08-18 spellings
   ("From SOs:", "From SO:"). A PO raised before the rename records its source
   orders nowhere else, so a parser that knew only today's wording would return
   [] for it and this route would report a PO with no origin at all.

   Tokens are the doc numbers verbatim (company prefix already stripped by the
   writer); the caller VALIDATES them against real SOs by an equality lookup,
   which is what enforces whole-token matching — a split token "SO-1" can only
   ever equal the SO "SO-1", never "SO-10". */
export { parseProvenanceNote };

export const noteMentionsToken = (note: string, token: string): boolean => {
  if (!note || !token) return false;
  const re = new RegExp(`(?<!${DOC_TOKEN_CHAR.source})${escapeRegExp(token)}(?!${DOC_TOKEN_CHAR.source})`, 'i');
  return re.test(note);
};

type ReadRes = <T = any>(
  label: string, ids: readonly string[], make: (b: string[], from: number, to: number) => PromiseLike<any>,
) => Promise<{ data: T[]; error: { message: string } | null }>;

async function resolveRootSos(sb: any, c: Context<any>, type: NodeType, id: string, rd: ReadRes): Promise<string[]> {
  switch (type) {
    case 'so':
      return [id];
    case 'do': {
      const { data } = await scopeToCompany(sb.from('delivery_orders').select('so_doc_no').eq('id', id), c).maybeSingle();
      if (data?.so_doc_no) return [data.so_doc_no];
      const { data: lines } = await scopeToCompany(sb.from('delivery_order_items').select('so_item_id').eq('delivery_order_id', id), c);
      return soDocNosFromSoItems(c, uniq((lines ?? []).map((l: any) => l.so_item_id)), sb, rd);
    }
    case 'si': {
      const { data } = await scopeToCompany(sb.from('sales_invoices').select('so_doc_no, delivery_order_id').eq('id', id), c).maybeSingle();
      if (data?.so_doc_no) return [data.so_doc_no];
      if (data?.delivery_order_id) return resolveRootSos(sb, c, 'do', data.delivery_order_id, rd);
      const { data: lines } = await scopeToCompany(sb.from('sales_invoice_items').select('so_item_id, do_item_id').eq('sales_invoice_id', id), c);
      const soItems = uniq((lines ?? []).map((l: any) => l.so_item_id));
      if (soItems.length) return soDocNosFromSoItems(c, soItems, sb, rd);
      const doItems = uniq((lines ?? []).map((l: any) => l.do_item_id));
      return soDocNosFromDoItems(c, doItems, sb, rd);
    }
    case 'payment': {
      const { data } = await scopeToCompany(sb.from('sales_invoice_payments').select('sales_invoice_id').eq('id', id), c).maybeSingle();
      return data?.sales_invoice_id ? resolveRootSos(sb, c, 'si', data.sales_invoice_id, rd) : [];
    }
    case 'po': {
      const { data: lines } = await rd<{ so_item_id: string | null }>('anchor purchase_order_items', [id], (b, f, t) =>
        scopeToCompany(sb.from('purchase_order_items').select('so_item_id').in('purchase_order_id', b), c).order('id').range(f, t));
      const linked = await soDocNosFromSoItems(c, uniq(lines.map((l) => l.so_item_id)), sb, rd);
      if (linked.length) return linked;
      /* Pre-MRP fallback (owner 2026-07-27 — PO-map parity with po-so-coverage
         linkage (b2)): a PO raised before the so_item_id link existed records
         its source SOs only in its own "From SOs: …" note — an authoritative
         raise-time record, not a guess. Tokens flow back as candidate roots;
         the main handler's company-ownership filter (.in('doc_no', …)
         .eq('company_id', cid)) is the equality validation that keeps only
         real, owned SOs — the same gate every other root passes through. */
      const { data: poHdr } = await scopeToCompany(sb.from('purchase_orders').select('notes').eq('id', id), c).maybeSingle();
      return parseProvenanceNote((poHdr as { notes?: string | null } | null)?.notes);
    }
    case 'grn': {
      const { data } = await scopeToCompany(sb.from('grns').select('purchase_order_id').eq('id', id), c).maybeSingle();
      return data?.purchase_order_id ? resolveRootSos(sb, c, 'po', data.purchase_order_id, rd) : [];
    }
    case 'pi': {
      /* Multi-GRN PIs (owner 2026-08-06) — the header grn_id is the PRIMARY
         note only, so walk EVERY note this PI bills (via its lines) and union
         their root SOs; fall back to the header when the lines resolve none. */
      const { data: piLines } = await sb.from('purchase_invoice_items')
        .select('grn_item_id').eq('purchase_invoice_id', id);
      const grnItemIds = uniq(((piLines ?? []) as Array<{ grn_item_id: string | null }>).map((r) => r.grn_item_id));
      const grnIds: string[] = [];
      if (grnItemIds.length) {
        const { data: gis } = await rd<{ grn_id: string | null }>('anchor grn_items', grnItemIds, (b, f, t) =>
          sb.from('grn_items').select('grn_id').in('id', b).order('id').range(f, t));
        grnIds.push(...uniq(gis.map((r) => r.grn_id)));
      }
      if (grnIds.length) {
        const all = await Promise.all(grnIds.map((gid) => resolveRootSos(sb, c, 'grn', gid, rd)));
        return uniq(all.flat());
      }
      const { data } = await scopeToCompany(sb.from('purchase_invoices').select('grn_id').eq('id', id), c).maybeSingle();
      return data?.grn_id ? resolveRootSos(sb, c, 'grn', data.grn_id, rd) : [];
    }
    case 'dr': {
      const { data } = await scopeToCompany(sb.from('delivery_returns').select('delivery_order_id').eq('id', id), c).maybeSingle();
      return data?.delivery_order_id ? resolveRootSos(sb, c, 'do', data.delivery_order_id, rd) : [];
    }
    case 'pr': {
      const { data } = await scopeToCompany(sb.from('purchase_returns').select('grn_id, purchase_order_id').eq('id', id), c).maybeSingle();
      if (data?.grn_id) return resolveRootSos(sb, c, 'grn', data.grn_id, rd);
      return data?.purchase_order_id ? resolveRootSos(sb, c, 'po', data.purchase_order_id, rd) : [];
    }
    default:
      return [];
  }
}

async function soDocNosFromSoItems(c: Context<any>, soItemIds: string[], sb: any, rd: ReadRes): Promise<string[]> {
  const { data } = await rd<{ doc_no: string | null }>('anchor mfg_sales_order_items', soItemIds, (b, f, t) =>
    scopeToCompany(sb.from('mfg_sales_order_items').select('doc_no').in('id', b), c).order('id').range(f, t));
  return uniq(data.map((r) => r.doc_no));
}
async function soDocNosFromDoItems(c: Context<any>, doItemIds: string[], sb: any, rd: ReadRes): Promise<string[]> {
  const { data } = await rd<{ so_item_id: string | null }>('anchor delivery_order_items', doItemIds, (b, f, t) =>
    scopeToCompany(sb.from('delivery_order_items').select('so_item_id').in('id', b), c).order('id').range(f, t));
  return soDocNosFromSoItems(c, uniq(data.map((r) => r.so_item_id)), sb, rd);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildConsignmentFlow(sb: any, c: Context<any>, type: NodeType, id: string, cid: number | null) {
  const anchorKey = keyOf(type, id);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind, linkage: 'chain' });
  };
  const orphan = (rootSos: string[]) => {
    if (nodes.size === 0) nodes.set(anchorKey, { key: anchorKey, type, id, label: id, status: null, isAnchor: true });
    return { nodes: [...nodes.values()], edges, rootSos };
  };

  if (type === 'cso' || type === 'cdo' || type === 'cdr') {
    let rootDoc: string | null = null;
    if (type === 'cso') rootDoc = id;
    else if (type === 'cdo') {
      const { data } = await scopeToCompany(sb.from('consignment_delivery_orders').select('consignment_so_doc_no').eq('id', id), c).maybeSingle();
      rootDoc = data?.consignment_so_doc_no ?? null;
    } else {
      const { data } = await scopeToCompany(sb.from('consignment_delivery_returns').select('consignment_do_id').eq('id', id), c).maybeSingle();
      if (data?.consignment_do_id) {
        const { data: doRow } = await sb.from('consignment_delivery_orders').select('consignment_so_doc_no').eq('id', data.consignment_do_id).maybeSingle();
        rootDoc = doRow?.consignment_so_doc_no ?? null;
      }
    }
    if (!rootDoc) return orphan([]);

    if (cid != null) {
      const { data: own } = await sb.from('consignment_sales_orders').select('company_id').eq('doc_no', rootDoc).maybeSingle();
      if (!own || Number(own.company_id) !== cid) return orphan([]);
    }

    const { data: so } = await sb.from('consignment_sales_orders').select('doc_no, status').eq('doc_no', rootDoc).maybeSingle();
    if (so) {
      const k = keyOf('cso', so.doc_no);
      nodes.set(k, { key: k, type: 'cso', id: so.doc_no, label: so.doc_no, status: so.status ?? null, isAnchor: k === anchorKey });
    }
    const { data: soLines } = await sb.from('consignment_sales_order_items').select('id, qty').eq('doc_no', rootDoc);
    const soItemQty = new Map<string, number>();
    for (const l of (soLines ?? []) as any[]) soItemQty.set(l.id, Number(l.qty ?? 0));
    const soItemIds = [...soItemQty.keys()];

    const { data: doHeaders } = await sb.from('consignment_delivery_orders').select('id, do_number, status').eq('consignment_so_doc_no', rootDoc);
    const doIds = uniq((doHeaders ?? []).map((d: any) => d.id));
    const doLines = soItemIds.length
      ? (await sb.from('consignment_delivery_order_items').select('id, consignment_delivery_order_id, consignment_so_item_id, qty').in('consignment_so_item_id', soItemIds)).data ?? []
      : [];
    const doItemMeta = new Map<string, { doId: string; qty: number }>();
    const soToDo = new Map<string, { childQty: number; parentItems: Set<string> }>();
    for (const l of (doLines as any[])) {
      doItemMeta.set(l.id, { doId: l.consignment_delivery_order_id, qty: Number(l.qty ?? 0) });
      if (!l.consignment_so_item_id) continue;
      const agg = soToDo.get(l.consignment_delivery_order_id) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty ?? 0);
      agg.parentItems.add(l.consignment_so_item_id);
      soToDo.set(l.consignment_delivery_order_id, agg);
    }
    for (const d of (doHeaders ?? []) as any[]) {
      const k = keyOf('cdo', d.id);
      nodes.set(k, { key: k, type: 'cdo', id: d.id, label: d.do_number ?? d.id, status: d.status ?? null, isAnchor: k === anchorKey });
      const agg = soToDo.get(d.id);
      const parentQty = agg ? [...agg.parentItems].reduce((s, si) => s + (soItemQty.get(si) ?? 0), 0) : 0;
      addEdge(keyOf('cso', rootDoc), k, agg ? cover(agg.childQty, parentQty) : 'full');
    }

    if (doIds.length) {
      const { data: drHeaders } = await sb.from('consignment_delivery_returns').select('id, return_number, status, consignment_do_id').in('consignment_do_id', doIds);
      const drIds = uniq((drHeaders ?? []).map((d: any) => d.id));
      const drLines = drIds.length
        ? (await sb.from('consignment_delivery_return_items').select('consignment_delivery_return_id, consignment_do_item_id, qty_returned').in('consignment_delivery_return_id', drIds)).data ?? []
        : [];
      const doToDr = new Map<string, { childQty: number; parentItems: Set<string> }>();
      for (const l of (drLines as any[])) {
        const dm = l.consignment_do_item_id ? doItemMeta.get(l.consignment_do_item_id) : undefined;
        if (!dm) continue;
        const kk = `${dm.doId}|${l.consignment_delivery_return_id}`;
        const agg = doToDr.get(kk) ?? { childQty: 0, parentItems: new Set<string>() };
        agg.childQty += Number(l.qty_returned ?? 0);
        agg.parentItems.add(l.consignment_do_item_id);
        doToDr.set(kk, agg);
      }
      for (const d of (drHeaders ?? []) as any[]) {
        const k = keyOf('cdr', d.id);
        nodes.set(k, { key: k, type: 'cdr', id: d.id, label: d.return_number ?? d.id, status: d.status ?? null, isAnchor: k === anchorKey });
        if (d.consignment_do_id) {
          const agg = doToDr.get(`${d.consignment_do_id}|${d.id}`);
          const parentQty = agg ? [...agg.parentItems].reduce((s, di) => s + (doItemMeta.get(di)?.qty ?? 0), 0) : 0;
          addEdge(keyOf('cdo', d.consignment_do_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
        }
      }
    }
    return orphan([rootDoc]);
  }

  let rootPco: string | null = null;
  if (type === 'pco') rootPco = id;
  else if (type === 'pcr') {
    const { data } = await scopeToCompany(sb.from('purchase_consignment_receives').select('purchase_consignment_order_id').eq('id', id), c).maybeSingle();
    rootPco = data?.purchase_consignment_order_id ?? null;
  } else {
    const { data } = await scopeToCompany(sb.from('purchase_consignment_returns').select('pc_order_id, pc_receive_id').eq('id', id), c).maybeSingle();
    if (data?.pc_order_id) rootPco = data.pc_order_id;
    else if (data?.pc_receive_id) {
      const { data: rec } = await sb.from('purchase_consignment_receives').select('purchase_consignment_order_id').eq('id', data.pc_receive_id).maybeSingle();
      rootPco = rec?.purchase_consignment_order_id ?? null;
    }
  }
  if (!rootPco) return orphan([]);

  if (cid != null) {
    const { data: own } = await sb.from('purchase_consignment_orders').select('company_id').eq('id', rootPco).maybeSingle();
    if (!own || Number(own.company_id) !== cid) return orphan([]);
  }

  const { data: po } = await sb.from('purchase_consignment_orders').select('id, pc_number, status').eq('id', rootPco).maybeSingle();
  if (po) {
    const k = keyOf('pco', po.id);
    nodes.set(k, { key: k, type: 'pco', id: po.id, label: po.pc_number ?? po.id, status: po.status ?? null, isAnchor: k === anchorKey });
  }
  const { data: poLines } = await sb.from('purchase_consignment_order_items').select('id, qty').eq('purchase_consignment_order_id', rootPco);
  const poItemQty = new Map<string, number>();
  for (const l of poLines) poItemQty.set(l.id, Number(l.qty ?? 0));
  const poItemIds = [...poItemQty.keys()];

  const { data: recHeaders } = await sb.from('purchase_consignment_receives').select('id, receive_number, status').eq('purchase_consignment_order_id', rootPco);
  const recIds = uniq((recHeaders ?? []).map((r: any) => r.id));
  const recLines = poItemIds.length
    ? (await sb.from('purchase_consignment_receive_items').select('id, pc_receive_id, pc_order_item_id, qty_accepted').in('pc_order_item_id', poItemIds)).data ?? []
    : [];
  const recItemMeta = new Map<string, { recId: string; qty: number }>();
  const poToRec = new Map<string, { childQty: number; parentItems: Set<string> }>();
  for (const l of (recLines as any[])) {
    recItemMeta.set(l.id, { recId: l.pc_receive_id, qty: Number(l.qty_accepted ?? 0) });
    if (!l.pc_order_item_id) continue;
    const agg = poToRec.get(l.pc_receive_id) ?? { childQty: 0, parentItems: new Set<string>() };
    agg.childQty += Number(l.qty_accepted ?? 0);
    agg.parentItems.add(l.pc_order_item_id);
    poToRec.set(l.pc_receive_id, agg);
  }
  for (const r of (recHeaders ?? []) as any[]) {
    const k = keyOf('pcr', r.id);
    nodes.set(k, { key: k, type: 'pcr', id: r.id, label: r.receive_number ?? r.id, status: r.status ?? null, isAnchor: k === anchorKey });
    const agg = poToRec.get(r.id);
    const parentQty = agg ? [...agg.parentItems].reduce((s, pi) => s + (poItemQty.get(pi) ?? 0), 0) : 0;
    addEdge(keyOf('pco', rootPco), k, agg ? cover(agg.childQty, parentQty) : 'full');
  }

  const { data: retByReceive } = recIds.length
    ? await sb.from('purchase_consignment_returns').select('id, return_number, status, pc_receive_id, pc_order_id').in('pc_receive_id', recIds)
    : { data: [] };
  const { data: retByOrder } = await sb.from('purchase_consignment_returns').select('id, return_number, status, pc_receive_id, pc_order_id').eq('pc_order_id', rootPco);
  const retById = new Map<string, any>();
  for (const r of [...((retByReceive ?? []) as any[]), ...((retByOrder ?? []) as any[])]) retById.set(r.id, r);
  const retIds = [...retById.keys()];
  const retLines = retIds.length
    ? (await sb.from('purchase_consignment_return_items').select('purchase_consignment_return_id, pc_receive_item_id, qty_returned').in('purchase_consignment_return_id', retIds)).data ?? []
    : [];
  const recToRet = new Map<string, { childQty: number; parentItems: Set<string> }>();
  for (const l of (retLines as any[])) {
    const rm = l.pc_receive_item_id ? recItemMeta.get(l.pc_receive_item_id) : undefined;
    if (!rm) continue;
    const kk = `${rm.recId}|${l.purchase_consignment_return_id}`;
    const agg = recToRet.get(kk) ?? { childQty: 0, parentItems: new Set<string>() };
    agg.childQty += Number(l.qty_returned ?? 0);
    agg.parentItems.add(l.pc_receive_item_id);
    recToRet.set(kk, agg);
  }
  for (const r of retById.values()) {
    const k = keyOf('pcrn', r.id);
    nodes.set(k, { key: k, type: 'pcrn', id: r.id, label: r.return_number ?? r.id, status: r.status ?? null, isAnchor: k === anchorKey });
    let linked = false;
    if (r.pc_receive_id && nodes.has(keyOf('pcr', r.pc_receive_id))) {
      const agg = recToRet.get(`${r.pc_receive_id}|${r.id}`);
      const parentQty = agg ? [...agg.parentItems].reduce((s, ri) => s + (recItemMeta.get(ri)?.qty ?? 0), 0) : 0;
      addEdge(keyOf('pcr', r.pc_receive_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
      linked = true;
    }
    if (!linked) addEdge(keyOf('pco', rootPco), k, 'full');
  }
  return orphan([rootPco]);
}

documentFlow.get('/candidate-pos/:soDocNo', async (c) => {
  const sb = c.get('supabase');
  const soDocNo = c.req.param('soDocNo');
  const cid = activeCompanyId(c);

  if (cid != null) {
    const { data: so } = await sb.from('mfg_sales_orders')
      .select('doc_no').eq('doc_no', soDocNo).eq('company_id', cid).maybeSingle();
    if (!so) return c.json({ candidates: [] });
  }

  const { data: soItems } = await sb.from('mfg_sales_order_items')
    .select('item_code').eq('doc_no', soDocNo);
  const codes = uniq((soItems ?? []).map((r: any) => r.item_code));
  if (codes.length === 0) return c.json({ candidates: [] });

  const { data: poItems, error: poErr } = await pgrestIn(sb.from('purchase_order_items')
    .select('purchase_order_id'), 'item_code', codes)
    .is('so_item_id', null);
  if (poErr) {
    // eslint-disable-next-line no-console
    console.error('[document-flow] purchase_order_items read failed:', (poErr as { message?: unknown }).message ?? poErr);
  }
  const poIds = uniq((poItems ?? []).map((r: any) => r.purchase_order_id));
  if (poIds.length === 0) return c.json({ candidates: [] });

  type CandidatePoRow = { id: string; po_number: string; status: string | null; po_date: string | null };
  const { data: pos } = await chunkIn<CandidatePoRow>(poIds, (batch, from, to) => scopeToCompany(
    sb.from('purchase_orders')
      .select('id, po_number, status, po_date')
      .in('id', batch)
      .neq('status', 'CANCELLED'),
    c,
  ).order('id').range(from, to));
  const candidates = pos
    .map((p) => ({ id: p.id, poNumber: p.po_number, status: p.status, poDate: p.po_date }))
    .sort((a, b) =>
      (b.poDate ?? '').localeCompare(a.poDate ?? '') || b.poNumber.localeCompare(a.poNumber));
  return c.json({ candidates });
});

documentFlow.get('/:type/:id', async (c) => {
  const sb = c.get('supabase');
  const type = c.req.param('type') as NodeType;
  const id = c.req.param('id');
  const ALL_TYPES: NodeType[] = ['so', 'do', 'si', 'payment', 'po', 'grn', 'pi', 'dr', 'pr', ...CONSIGNMENT_TYPES];
  if (!ALL_TYPES.includes(type)) {
    return c.json({ error: 'bad_type' }, 400);
  }

  const cid = activeCompanyId(c);

  const degraded: string[] = [];
  const readRes: ReadRes = async (label, ids, make) => {
    let { data, error } = await chunkIn<any>(ids, make);
    if (error) ({ data, error } = await chunkIn<any>(ids, make));
    if (error) { degraded.push(label); console.error(`[document-flow] ${label} read failed:`, error.message); }
    return { data, error };
  };
  const readIn = async <T = any>(label: string, ids: readonly string[], make: (b: string[], from: number, to: number) => PromiseLike<any>): Promise<T[]> =>
    (await readRes<T>(label, ids, make)).data;

  if (CONSIGNMENT_TYPES.includes(type)) {
    return c.json({ ...(await buildConsignmentFlow(sb, c, type, id, cid ?? null)), degraded });
  }

  let rootSos = await resolveRootSos(sb, c, type, id, readRes);

  if (cid != null && rootSos.length > 0) {
    const { data: owned } = await sb
      .from('mfg_sales_orders')
      .select('doc_no')
      .in('doc_no', rootSos)
      .eq('company_id', cid);
    rootSos = uniq((owned ?? []).map((r: any) => r.doc_no));
  }

  const anchorKey = keyOf(type, id);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const addEdge = (from: string, to: string, kind: EdgeKind, linkage: EdgeLinkage = 'chain') => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind, linkage });
  };

  if (rootSos.length === 0) {
    nodes.set(anchorKey, { key: anchorKey, type, id, label: id, status: null, isAnchor: true });

    /* …except the PURCHASE side (owner 2026-07-27): a stock buy / unlinked PO is
       still the head of its own receipt chain — grns.purchase_order_id hangs off
       the PO regardless of any SO, and hiding those would paint "Not created"
       over real receipts (the same lying-node class audit R8 killed on the sales
       maps). So a PO anchor expands its own downstream (PO ▶ GRN ▶ PI / PR)
       before returning; a GRN anchor on such a PO expands the SAME subtree off
       its parent PO, so the GRN map still shows the PO it came from and the
       PI / PR it became — differing only in which node carries isAnchor. Every
       other orphan type keeps the lone-anchor shape. Reads mirror sections 6/7/9
       below and are company-scoped on the PO/GRN hops, so a foreign id still
       collapses to the bare anchor. The GRN edge keeps real partial/full
       coverage; PI/PR edges default 'full' (coverage colouring matters on the
       receipt hop — billing splits on a stock buy are cosmetic). */
    let poAmendments: Array<{ id: string; poId: string; poNumber: string; amendmentNo: number | string; status: string | null; createdAt: string | null }> = [];
    const expandPoId =
      type === 'po'
        ? id
        : type === 'grn'
          ? (await scopeToCompany(sb.from('grns').select('purchase_order_id').eq('id', id), c).maybeSingle()).data?.purchase_order_id ?? null
          : null;
    if (expandPoId) {
      const poKey = keyOf('po', expandPoId);
      const { data: poHdr } = await scopeToCompany(sb.from('purchase_orders').select('po_number, status').eq('id', expandPoId), c).maybeSingle();
      if (poHdr) {
        nodes.set(poKey, { key: poKey, type: 'po', id: expandPoId, label: poHdr.po_number ?? expandPoId, status: poHdr.status ?? null, isAnchor: poKey === anchorKey });
      }
      const poLines = await readIn('orphan purchase_order_items', [expandPoId], (b, f, t) =>
        scopeToCompany(sb.from('purchase_order_items').select('id, qty').in('purchase_order_id', b), c).order('id').range(f, t));
      const poItemQty = new Map<string, { poId: string; qty: number }>();
      for (const l of poLines) poItemQty.set(l.id, { poId: expandPoId, qty: Number(l.qty ?? 0) });
      const poItemIds = [...poItemQty.keys()];

      const grnLinesRes = await readRes('orphan grn_items', poItemIds, (b, f, t) =>
        scopeToCompany(sb.from('grn_items').select('id, grn_id, purchase_order_item_id, qty:qty_accepted').in('purchase_order_item_id', b), c).order('id').range(f, t));
      const grnLines = grnLinesRes.data;
      const grnById = new Map<string, any>();
      const { data: grnHdrs } = await scopeToCompany(sb.from('grns').select('id, grn_number, status, purchase_order_id').eq('purchase_order_id', expandPoId), c);
      for (const g of (grnHdrs ?? []) as any[]) grnById.set(g.id, g);
      const missingGrnIds = uniq(grnLines.map((l) => l.grn_id)).filter((gid) => !grnById.has(gid));
      for (const g of await readIn('orphan grns(by line)', missingGrnIds, (b, f, t) =>
        scopeToCompany(sb.from('grns').select('id, grn_number, status, purchase_order_id').in('id', b), c).order('id').range(f, t))) {
        if (!grnById.has(g.id)) grnById.set(g.id, g);
      }
      const grnIds = [...grnById.keys()];
      const poGrnCoverage = grnLinesRes.error ? new Map() : derivePoGrnCoverage(poItemQty, grnLines);
      for (const g of grnById.values()) {
        const k = keyOf('grn', g.id);
        nodes.set(k, { key: k, type: 'grn', id: g.id, label: g.grn_number ?? g.id, status: g.status ?? null, isAnchor: k === anchorKey });
      }
      const grnEdged = new Set<string>();
      for (const [ck, cov] of poGrnCoverage) {
        const [pid, gid] = ck.split('|');
        if (!pid || !gid || !nodes.has(keyOf('po', pid)) || !grnById.has(gid)) continue;
        addEdge(keyOf('po', pid), keyOf('grn', gid), cover(cov.childQty, cov.parentQty));
        grnEdged.add(gid);
      }
      for (const g of grnById.values()) {
        if (grnEdged.has(g.id)) continue;
        addEdge(poKey, keyOf('grn', g.id), 'full');
      }
      if (grnIds.length) {
        const myGrnItems = await readIn('orphan grn_items(by grn)', grnIds, (b, f, t) =>
          scopeToCompany(sb.from('grn_items').select('id, grn_id').in('grn_id', b), c).order('id').range(f, t));
        const myGrnItemIds = (myGrnItems as Array<{ id: string }>).map((r) => r.id);
        const grnIdByItem = new Map((myGrnItems as Array<{ id: string; grn_id: string }>).map((r) => [r.id, r.grn_id]));
        const piLineLinks = await readIn('orphan purchase_invoice_items', myGrnItemIds, (b, f, t) =>
          scopeToCompany(sb.from('purchase_invoice_items').select('id, purchase_invoice_id, grn_item_id').in('grn_item_id', b), c).order('id').range(f, t));
        const notesByPi = new Map<string, Set<string>>();
        for (const l of piLineLinks) {
          const gid = l.grn_item_id ? grnIdByItem.get(l.grn_item_id) : undefined;
          if (!gid) continue;
          const set = notesByPi.get(l.purchase_invoice_id) ?? new Set<string>();
          set.add(gid);
          notesByPi.set(l.purchase_invoice_id, set);
        }
        const pisByHeader = await readIn('orphan purchase_invoices(header)', grnIds, (b, f, t) =>
          scopeToCompany(sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('grn_id', b), c).order('id').range(f, t));
        const seen = new Set(pisByHeader.map((p: any) => p.id));
        const extraIds = [...notesByPi.keys()].filter((pid) => !seen.has(pid));
        const pisByLine = await readIn('orphan purchase_invoices(by line)', extraIds, (b, f, t) =>
          scopeToCompany(sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('id', b), c).order('id').range(f, t));
        for (const p of [...pisByHeader, ...pisByLine]) {
          const k = keyOf('pi', p.id);
          nodes.set(k, { key: k, type: 'pi', id: p.id, label: p.invoice_number ?? p.id, status: p.status ?? null, isAnchor: false });
          const notes = notesByPi.get(p.id);
          if (notes?.size) for (const gid of notes) addEdge(keyOf('grn', gid), k, 'full');
          else if (p.grn_id) addEdge(keyOf('grn', p.grn_id), k, 'full');
        }
        const prLineLinks = await readIn('orphan purchase_return_items', myGrnItemIds, (b, f, t) =>
          scopeToCompany(sb.from('purchase_return_items').select('id, purchase_return_id, grn_item_id').in('grn_item_id', b), c).order('id').range(f, t));
        const notesByPr = new Map<string, Set<string>>();
        for (const l of prLineLinks) {
          const gid = l.grn_item_id ? grnIdByItem.get(l.grn_item_id) : undefined;
          if (!gid) continue;
          const set = notesByPr.get(l.purchase_return_id) ?? new Set<string>();
          set.add(gid);
          notesByPr.set(l.purchase_return_id, set);
        }
        const prsByHeader = await readIn('orphan purchase_returns', grnIds, (b, f, t) =>
          scopeToCompany(sb.from('purchase_returns').select('id, return_number, status, grn_id').in('grn_id', b), c).order('id').range(f, t));
        const seenPr = new Set(prsByHeader.map((p) => p.id));
        const prsByLine = await readIn('orphan purchase_returns(by line)', [...notesByPr.keys()].filter((pid) => !seenPr.has(pid)), (b, f, t) =>
          scopeToCompany(sb.from('purchase_returns').select('id, return_number, status, grn_id').in('id', b), c).order('id').range(f, t));
        for (const p of [...prsByHeader, ...prsByLine]) {
          const k = keyOf('pr', p.id);
          nodes.set(k, { key: k, type: 'pr', id: p.id, label: p.return_number ?? p.id, status: p.status ?? null, isAnchor: false });
          const notes = notesByPr.get(p.id);
          if (notes?.size) for (const gid of notes) addEdge(keyOf('grn', gid), k, 'full');
          else if (p.grn_id) addEdge(keyOf('grn', p.grn_id), k, 'full');
        }
      }
      if (type === 'po') {
        const { data: poAmendRows } = await sb.from('po_amendments')
          .select('id, po_id, po_number, amendment_no, status, created_at')
          .eq('po_id', expandPoId)
          .order('amendment_no', { ascending: true });
        poAmendments = ((poAmendRows ?? []) as any[]).map((a) => ({
          id: String(a.id),
          poId: String(a.po_id),
          poNumber: a.po_number,
          amendmentNo: a.amendment_no,
          status: a.status ?? null,
          createdAt: a.created_at ?? null,
        }));
      }
    }
    return c.json({ nodes: [...nodes.values()], edges, rootSos, amendments: [], poAmendments, degraded });
  }

  const { data: soHeaders, error: soHeadersErr } = await sb.from('mfg_sales_orders').select('doc_no, status').in('doc_no', rootSos);
  if (soHeadersErr) return c.json(readFailure('document_flow', soHeadersErr), 500);
  for (const s of soHeaders as any[]) {
    const k = keyOf('so', s.doc_no);
    nodes.set(k, { key: k, type: 'so', id: s.doc_no, label: s.doc_no, status: s.status ?? null, isAnchor: k === anchorKey });
  }
  const { data: soLines, error: soLinesErr } = await sb.from('mfg_sales_order_items').select('id, doc_no, qty').in('doc_no', rootSos);
  if (soLinesErr) return c.json(readFailure('document_flow', soLinesErr), 500);
  const soItemQty = new Map<string, number>();
  const soItemToDoc = new Map<string, string>();
  for (const l of soLines as any[]) {
    soItemQty.set(l.id, Number(l.qty ?? 0));
    soItemToDoc.set(l.id, l.doc_no);
  }
  const soItemIds = [...soItemQty.keys()];

  const doLinesBySoItem = soItemIds.length
    ? (await sb.from('delivery_order_items').select('id, delivery_order_id, so_item_id, qty').in('so_item_id', soItemIds)).data ?? []
    : [];
  const { data: doByHeader, error: doByHeaderErr } = await sb.from('delivery_orders').select('id, do_number, status, so_doc_no').in('so_doc_no', rootSos);
  if (doByHeaderErr) return c.json(readFailure('document_flow', doByHeaderErr), 500);
  const doIds = uniq([
    ...(doByHeader as any[]).map((d) => d.id),
    ...((doLinesBySoItem) as any[]).map((l) => l.delivery_order_id),
  ]);
  const doHeaderById = new Map<string, any>();
  for (const d of doByHeader as any[]) doHeaderById.set(d.id, d);
  const missingDoIds = doIds.filter((d) => !doHeaderById.has(d));
  if (missingDoIds.length) {
    const { data: more, error: moreErr } = await sb.from('delivery_orders').select('id, do_number, status, so_doc_no').in('id', missingDoIds);
    if (moreErr) return c.json(readFailure('document_flow', moreErr), 500);
    for (const d of more as any[]) doHeaderById.set(d.id, d);
  }
  const doItemMeta = new Map<string, { doId: string; qty: number; soItemId: string | null }>();
  const soToDo = new Map<string, { childQty: number; parentItems: Set<string> }>();
  for (const l of (doLinesBySoItem) as any[]) {
    doItemMeta.set(l.id, { doId: l.delivery_order_id, qty: Number(l.qty ?? 0), soItemId: l.so_item_id ?? null });
    const soDoc = l.so_item_id ? soItemToDoc.get(l.so_item_id) : undefined;
    if (!soDoc) continue;
    const k = `${soDoc}|${l.delivery_order_id}`;
    const agg = soToDo.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
    agg.childQty += Number(l.qty ?? 0);
    agg.parentItems.add(l.so_item_id);
    soToDo.set(k, agg);
  }
  for (const d of doHeaderById.values()) {
    const k = keyOf('do', d.id);
    nodes.set(k, { key: k, type: 'do', id: d.id, label: d.do_number ?? d.id, status: d.status ?? null, isAnchor: k === anchorKey });
  }
  for (const d of doHeaderById.values()) {
    const soDoc = d.so_doc_no && rootSos.includes(d.so_doc_no) ? d.so_doc_no : rootSos.find((s) => soToDo.has(`${s}|${d.id}`));
    if (!soDoc) continue;
    const agg = soToDo.get(`${soDoc}|${d.id}`);
    const parentQty = agg ? [...agg.parentItems].reduce((s, si) => s + (soItemQty.get(si) ?? 0), 0) : 0;
    addEdge(keyOf('so', soDoc), keyOf('do', d.id), agg ? cover(agg.childQty, parentQty) : 'full');
  }

  const doItemIds = [...doItemMeta.keys()];
  const siByHeaderDo = doIds.length
    ? (await sb.from('sales_invoices').select('id, invoice_number, status, so_doc_no, delivery_order_id').in('delivery_order_id', doIds)).data ?? []
    : [];
  const { data: siBySoDoc, error: siBySoDocErr } = await sb.from('sales_invoices').select('id, invoice_number, status, so_doc_no, delivery_order_id').in('so_doc_no', rootSos);
  if (siBySoDocErr) return c.json(readFailure('document_flow', siBySoDocErr), 500);
  const siLineLinks = doItemIds.length
    ? (await sb.from('sales_invoice_items').select('sales_invoice_id, do_item_id, so_item_id, qty').in('do_item_id', doItemIds)).data ?? []
    : [];
  const siById = new Map<string, any>();
  for (const s of [...(siByHeaderDo as any[]), ...(siBySoDoc as any[])]) siById.set(s.id, s);
  const lineSiIds = uniq((siLineLinks as any[]).map((l) => l.sales_invoice_id)).filter((sid) => !siById.has(sid));
  if (lineSiIds.length) {
    const { data: more, error: moreErr } = await sb.from('sales_invoices').select('id, invoice_number, status, so_doc_no, delivery_order_id').in('id', lineSiIds);
    if (moreErr) return c.json(readFailure('document_flow', moreErr), 500);
    for (const s of more as any[]) siById.set(s.id, s);
  }
  for (const s of siById.values()) {
    const k = keyOf('si', s.id);
    nodes.set(k, { key: k, type: 'si', id: s.id, label: s.invoice_number ?? s.id, status: s.status ?? null, isAnchor: k === anchorKey });
  }
  const doToSi = new Map<string, { childQty: number; parentItems: Set<string> }>();
  for (const l of (siLineLinks as any[])) {
    const dm = l.do_item_id ? doItemMeta.get(l.do_item_id) : undefined;
    if (!dm) continue;
    const k = `${dm.doId}|${l.sales_invoice_id}`;
    const agg = doToSi.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
    agg.childQty += Number(l.qty ?? 0);
    agg.parentItems.add(l.do_item_id);
    doToSi.set(k, agg);
  }
  for (const s of siById.values()) {
    let linked = false;
    for (const d of doHeaderById.values()) {
      const agg = doToSi.get(`${d.id}|${s.id}`);
      if (agg) {
        const parentQty = [...agg.parentItems].reduce((sum, di) => sum + (doItemMeta.get(di)?.qty ?? 0), 0);
        addEdge(keyOf('do', d.id), keyOf('si', s.id), cover(agg.childQty, parentQty));
        linked = true;
      } else if (s.delivery_order_id === d.id) {
        addEdge(keyOf('do', d.id), keyOf('si', s.id), 'full');
        linked = true;
      }
    }
    if (!linked && s.so_doc_no && rootSos.includes(s.so_doc_no)) {
      addEdge(keyOf('so', s.so_doc_no), keyOf('si', s.id), 'full');
    }
  }

  const siIds = [...siById.keys()];
  if (siIds.length) {
    const { data: pays, error: paysErr } = await sb.from('sales_invoice_payments')
      .select('id, sales_invoice_id, method, approval_code, amount_sen').in('sales_invoice_id', siIds);
    if (paysErr) return c.json(readFailure('document_flow', paysErr), 500);
    for (const p of pays as any[]) {
      const k = keyOf('payment', p.id);
      const label = p.approval_code?.trim() ? p.approval_code.trim() : `${(p.method ?? 'Payment')} ${fmtSen(Number(p.amount_sen ?? 0))}`;
      nodes.set(k, { key: k, type: 'payment', id: p.id, label, status: null, isAnchor: k === anchorKey });
      addEdge(keyOf('si', p.sales_invoice_id), k, 'payment');
    }
  }

  if (doIds.length) {
    const { data: drByHeader, error: drByHeaderErr } = await sb.from('delivery_returns')
      .select('id, return_number, status, delivery_order_id').in('delivery_order_id', doIds);
    if (drByHeaderErr) return c.json(readFailure('document_flow', drByHeaderErr), 500);
    const drIds = uniq(drByHeader.map((d: any) => d.id));
    const drLineLinks = drIds.length
      ? (await sb.from('delivery_return_items').select('delivery_return_id, do_item_id, qty_returned').in('delivery_return_id', drIds)).data ?? []
      : [];
    const doToDr = new Map<string, { childQty: number; parentItems: Set<string> }>();
    for (const l of (drLineLinks as any[])) {
      const dm = l.do_item_id ? doItemMeta.get(l.do_item_id) : undefined;
      if (!dm) continue;
      const k = `${dm.doId}|${l.delivery_return_id}`;
      const agg = doToDr.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty_returned ?? 0);
      agg.parentItems.add(l.do_item_id);
      doToDr.set(k, agg);
    }
    for (const d of drByHeader as any[]) {
      const k = keyOf('dr', d.id);
      nodes.set(k, { key: k, type: 'dr', id: d.id, label: d.return_number ?? d.id, status: d.status ?? null, isAnchor: k === anchorKey });
      if (d.delivery_order_id) {
        const agg = doToDr.get(`${d.delivery_order_id}|${d.id}`);
        const parentQty = agg ? [...agg.parentItems].reduce((s, di) => s + (doItemMeta.get(di)?.qty ?? 0), 0) : 0;
        addEdge(keyOf('do', d.delivery_order_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
      }
    }
  }

  const poItemLinks = await readIn('purchase_order_items(by so item)', soItemIds, (b, f, t) =>
    sb.from('purchase_order_items').select('id, purchase_order_id, so_item_id, qty').in('so_item_id', b).order('id').range(f, t));

  const bareTokens = rootSos.map((d) => stripCompanyPrefix(d)).filter(Boolean);
  const noteEdges: Array<{ soDoc: string; poId: string }> = [];
  const notePoIds: string[] = [];
  if (cid != null && bareTokens.length) {
    const { data: notedPos, error: notedErr } = await paginateAll<any>((f, t) => sb.from('purchase_orders')
      .select('id, notes').eq('company_id', cid).not('notes', 'is', null).order('id').range(f, t));
    if (notedErr) { degraded.push('purchase_orders(notes)'); console.error('[document-flow] purchase_orders(notes) read failed:', notedErr.message); }
    for (const p of notedPos ?? []) {
      const note = String(p.notes ?? '');
      let matched = false;
      for (let i = 0; i < rootSos.length; i++) {
        const full = rootSos[i]!;
        const t = bareTokens[i];
        if (noteMentionsToken(note, full) || (t && noteMentionsToken(note, t))) {
          noteEdges.push({ soDoc: full, poId: p.id });
          matched = true;
        }
      }
      if (matched) notePoIds.push(p.id);
    }
  }

  if (notePoIds.length) {
    const fk = await readRes<{ purchase_order_id: string }>('purchase_order_items(fk-over-note)', uniq(notePoIds), (b, f, t) =>
      sb.from('purchase_order_items').select('id, purchase_order_id').in('purchase_order_id', b)
        .not('so_item_id', 'is', null).order('id').range(f, t));
    if (!fk.error) {
      const fkLinkedPoIds = new Set(fk.data.map((r) => r.purchase_order_id));
      if (fkLinkedPoIds.size) {
        const kept = noteEdges.filter((e) => !fkLinkedPoIds.has(e.poId));
        noteEdges.length = 0;
        noteEdges.push(...kept);
        notePoIds.length = 0;
        notePoIds.push(...uniq(kept.map((e) => e.poId)));
      }
    }
  }

  const poIds = uniq([...poItemLinks.map((l) => l.purchase_order_id), ...notePoIds]);
  if (poIds.length) {
    const pos = await readIn('purchase_orders', poIds, (b, f, t) =>
      sb.from('purchase_orders').select('id, po_number, status').in('id', b).order('id').range(f, t));
    for (const p of pos) {
      const k = keyOf('po', p.id);
      nodes.set(k, { key: k, type: 'po', id: p.id, label: p.po_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
    }
    const poToSo = new Map<string, Set<string>>();
    for (const l of poItemLinks) {
      const soDoc = l.so_item_id ? soItemToDoc.get(l.so_item_id) : undefined;
      if (!soDoc) continue;
      const set = poToSo.get(l.purchase_order_id) ?? new Set<string>();
      set.add(soDoc);
      poToSo.set(l.purchase_order_id, set);
    }
    for (const { soDoc, poId } of noteEdges) {
      const set = poToSo.get(poId) ?? new Set<string>();
      set.add(soDoc);
      poToSo.set(poId, set);
    }
    for (const [poId, soDocs] of poToSo) for (const soDoc of soDocs) addEdge(keyOf('so', soDoc), keyOf('po', poId), 'value', 'provenance');
  }

  const allPoItemRows = await readIn('purchase_order_items', poIds, (b, f, t) =>
    sb.from('purchase_order_items').select('id, purchase_order_id, qty').in('purchase_order_id', b).order('id').range(f, t));
  const poItemQtyAll = new Map<string, { poId: string; qty: number }>();
  for (const r of allPoItemRows) poItemQtyAll.set(r.id, { poId: r.purchase_order_id, qty: Number(r.qty ?? 0) });
  const allPoItemIds = [...poItemQtyAll.keys()];
  const grnLineRes = await readRes('grn_items', allPoItemIds, (b, f, t) =>
    sb.from('grn_items').select('id, grn_id, purchase_order_item_id, qty:qty_accepted').in('purchase_order_item_id', b).order('id').range(f, t));
  const grnByHeader = await readIn('grns(header)', poIds, (b, f, t) =>
    sb.from('grns').select('id, grn_number, status, purchase_order_id').in('purchase_order_id', b).order('id').range(f, t));
  const grnById = new Map<string, any>();
  for (const g of grnByHeader) grnById.set(g.id, g);
  const grnLineLinks = grnLineRes.data;
  const missingGrnIds = uniq(grnLineLinks.map((l) => l.grn_id)).filter((gid) => !grnById.has(gid));
  for (const g of await readIn('grns(by line)', missingGrnIds, (b, f, t) =>
    sb.from('grns').select('id, grn_number, status, purchase_order_id').in('id', b).order('id').range(f, t))) {
    if (!grnById.has(g.id)) grnById.set(g.id, g);
  }
  const grnItemMeta = new Map<string, { grnId: string; qty: number }>();
  for (const l of grnLineLinks) grnItemMeta.set(l.id, { grnId: l.grn_id, qty: Number(l.qty ?? 0) });
  const poGrnCoverage = grnLineRes.error ? new Map() : derivePoGrnCoverage(poItemQtyAll, grnLineLinks);
  for (const g of grnById.values()) {
    const k = keyOf('grn', g.id);
    nodes.set(k, { key: k, type: 'grn', id: g.id, label: g.grn_number ?? g.id, status: g.status ?? null, isAnchor: k === anchorKey });
  }
  const grnEdged = new Set<string>();
  for (const [k, cov] of poGrnCoverage) {
    const [poId, grnId] = k.split('|');
    if (!poId || !grnId || !nodes.has(keyOf('po', poId)) || !grnById.has(grnId)) continue;
    addEdge(keyOf('po', poId), keyOf('grn', grnId), cover(cov.childQty, cov.parentQty));
    grnEdged.add(k);
  }
  for (const g of grnById.values()) {
    if (!g.purchase_order_id || !nodes.has(keyOf('po', g.purchase_order_id))) continue;
    if (grnEdged.has(`${g.purchase_order_id}|${g.id}`)) continue;
    addEdge(keyOf('po', g.purchase_order_id), keyOf('grn', g.id), 'full');
  }

  const grnIds = [...grnById.keys()];
  const grnItemIds = [...grnItemMeta.keys()];
  if (grnIds.length) {
    /* Multi-GRN PIs (owner 2026-08-06): one supplier invoice can bill several
       notes, so the header's grn_id is just the primary ref. Discover PIs by
       the LINE link (grn_item_id ∈ this family's GRN lines) UNION the header
       FK — a header-only match still appears (e.g. a PI whose lines were all
       deleted), and a PI whose header points at another family's note is no
       longer invisible here. */
    const piLineLinks = await readIn('purchase_invoice_items', grnItemIds, (b, f, t) =>
      sb.from('purchase_invoice_items').select('id, purchase_invoice_id, grn_item_id, qty').in('grn_item_id', b).order('id').range(f, t));
    const grnToPi = new Map<string, { childQty: number; parentItems: Set<string> }>();
    for (const l of piLineLinks) {
      const gm = l.grn_item_id ? grnItemMeta.get(l.grn_item_id) : undefined;
      if (!gm) continue;
      const k = `${gm.grnId}|${l.purchase_invoice_id}`;
      const agg = grnToPi.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty ?? 0);
      agg.parentItems.add(l.grn_item_id);
      grnToPi.set(k, agg);
    }
    const piIdsFromLines = uniq(piLineLinks.map((l: any) => l.purchase_invoice_id));
    const pisByHeader = await readIn('purchase_invoices(header)', grnIds, (b, f, t) =>
      sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('grn_id', b).order('id').range(f, t));
    const knownPiIds = new Set(pisByHeader.map((p: any) => p.id));
    const missingPiIds = piIdsFromLines.filter((pid) => !knownPiIds.has(pid));
    const pisByLine = await readIn('purchase_invoices(by line)', missingPiIds, (b, f, t) =>
      sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('id', b).order('id').range(f, t));
    const pis = [...pisByHeader, ...pisByLine];
    for (const p of pis) {
      const k = keyOf('pi', p.id);
      nodes.set(k, { key: k, type: 'pi', id: p.id, label: p.invoice_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
      const billed = [...grnToPi.entries()].filter(([key]) => key.endsWith(`|${p.id}`));
      if (billed.length) {
        for (const [key, agg] of billed) {
          const grnId = key.slice(0, key.length - `|${p.id}`.length);
          const parentQty = [...agg.parentItems].reduce((s, gi) => s + (grnItemMeta.get(gi)?.qty ?? 0), 0);
          addEdge(keyOf('grn', grnId), k, cover(agg.childQty, parentQty));
        }
      } else if (p.grn_id) {
        addEdge(keyOf('grn', p.grn_id), k, 'full');
      }
    }
  }

  if (grnIds.length) {
    /* A return raised from the PO (Raise Return, ?poId=) draws lines from
       several receipts and leaves the header grn_id NULL, so the header FK
       alone hid it from the PO's map (HC-0139, HC-PRT-2610-001). Discover by
       the LINE link UNION the header, same as the Purchase Invoices above. */
    const prLinesByGrnItem = await readIn('purchase_return_items(by grn line)', grnItemIds, (b, f, t) =>
      sb.from('purchase_return_items').select('purchase_return_id').in('grn_item_id', b).order('id').range(f, t));
    const prByHeader = await readIn('purchase_returns', grnIds, (b, f, t) =>
      sb.from('purchase_returns').select('id, return_number, status, grn_id').in('grn_id', b).order('id').range(f, t));
    const knownPrIds = new Set(prByHeader.map((p: any) => p.id));
    const missingPrIds = uniq(prLinesByGrnItem.map((l: any) => l.purchase_return_id)).filter((pid) => !knownPrIds.has(pid));
    const prByLine = await readIn('purchase_returns(by line)', missingPrIds, (b, f, t) =>
      sb.from('purchase_returns').select('id, return_number, status, grn_id').in('id', b).order('id').range(f, t));
    const prs = [...prByHeader, ...prByLine];
    const prIds = uniq(prs.map((p: any) => p.id));
    const prLineLinks = await readIn('purchase_return_items', prIds, (b, f, t) =>
      sb.from('purchase_return_items').select('id, purchase_return_id, grn_item_id, qty_returned').in('purchase_return_id', b).order('id').range(f, t));
    const grnToPr = new Map<string, { childQty: number; parentItems: Set<string> }>();
    for (const l of prLineLinks) {
      const gm = l.grn_item_id ? grnItemMeta.get(l.grn_item_id) : undefined;
      if (!gm) continue;
      const k = `${gm.grnId}|${l.purchase_return_id}`;
      const agg = grnToPr.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty_returned ?? 0);
      agg.parentItems.add(l.grn_item_id);
      grnToPr.set(k, agg);
    }
    for (const p of prs) {
      const k = keyOf('pr', p.id);
      nodes.set(k, { key: k, type: 'pr', id: p.id, label: p.return_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
      const returned = [...grnToPr.entries()].filter(([key]) => key.endsWith(`|${p.id}`));
      if (returned.length) {
        for (const [key, agg] of returned) {
          const grnId = key.slice(0, key.length - `|${p.id}`.length);
          const parentQty = [...agg.parentItems].reduce((s, gi) => s + (grnItemMeta.get(gi)?.qty ?? 0), 0);
          addEdge(keyOf('grn', grnId), k, cover(agg.childQty, parentQty));
        }
      } else if (p.grn_id) {
        addEdge(keyOf('grn', p.grn_id), k, 'full');
      }
    }
  }

  const { data: amendRows } = await sb.from('so_amendments')
    .select('id, so_doc_no, amendment_no, status, created_at')
    .in('so_doc_no', rootSos)
    .order('amendment_no', { ascending: true });
  const amendments = ((amendRows ?? []) as any[]).map((a) => ({
    id: String(a.id),
    soDocNo: a.so_doc_no,
    amendmentNo: a.amendment_no,
    status: a.status ?? null,
    createdAt: a.created_at ?? null,
  }));

  const poIdsInGraph = [...nodes.values()].filter((n) => n.type === 'po').map((n) => n.id);
  let poAmendments: Array<{ id: string; poId: string; poNumber: string; amendmentNo: number | string; status: string | null; createdAt: string | null }> = [];
  if (poIdsInGraph.length > 0) {
    const poAmendRows = await readIn('po_amendments', poIdsInGraph, (b, f, t) =>
      sb.from('po_amendments')
        .select('id, po_id, po_number, amendment_no, status, created_at')
        .in('po_id', b).order('amendment_no', { ascending: true }).order('id').range(f, t));
    poAmendments = poAmendRows.map((a) => ({
      id: String(a.id),
      poId: String(a.po_id),
      poNumber: a.po_number,
      amendmentNo: a.amendment_no,
      status: a.status ?? null,
      createdAt: a.created_at ?? null,
    }));
  }

  return c.json({ nodes: [...nodes.values()], edges, rootSos, amendments, poAmendments, degraded });
});

export default documentFlow;
