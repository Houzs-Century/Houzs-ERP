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
import type { Env, Variables } from '../env';

export const documentFlow = new Hono<{ Bindings: Env; Variables: Variables }>();
documentFlow.use('*', supabaseAuth);

type NodeType =
  | 'so' | 'do' | 'si' | 'payment' | 'po' | 'grn' | 'pi' | 'dr' | 'pr'
  // Consignment family (its own self-contained graph — not linked to the SO root):
  //   sales:    cso ──▶ cdo ──▶ cdr   (Consignment Order / Note / Return)
  //   purchase: pco ──▶ pcr ──▶ pcrn  (PC Order / Receive / Return)
  | 'cso' | 'cdo' | 'cdr' | 'pco' | 'pcr' | 'pcrn';
type EdgeKind = 'full' | 'partial' | 'value' | 'payment';

const CONSIGNMENT_TYPES: NodeType[] = ['cso', 'cdo', 'cdr', 'pco', 'pcr', 'pcrn'];

type FlowNode = {
  key: string;            // unique `${type}:${id}`
  type: NodeType;
  id: string;             // navigation key (doc_no for SO, uuid for the rest)
  label: string;          // human document number
  status: string | null;
  isAnchor: boolean;
};
type FlowEdge = { from: string; to: string; kind: EdgeKind };

const keyOf = (type: NodeType, id: string) => `${type}:${id}`;
const cover = (childQty: number, parentQty: number): EdgeKind =>
  parentQty > 0 && childQty + 1e-9 < parentQty ? 'partial' : 'full';
const uniq = (xs: Array<string | null | undefined>) =>
  [...new Set(xs.filter((x): x is string => !!x))];

/* A PO's "From SOs: …" note records source SO doc numbers with the company
   prefix stripped ("2990-SO-2606-033" → "SO-2606-033"); Houzs docs have no
   prefix and pass through unchanged. Strip a leading "<digits>-" so the token
   matches what the note actually contains. */
const stripCompanyPrefix = (docNo: string): string => docNo.replace(/^\d+-/, '');

/* R7 fix — WHOLE-TOKEN match of an SO doc number inside a PO's free-text "From
   SOs: …" note. A plain substring test (`note.includes('SO-1')`) wrongly links
   documents whose numbers are substrings of one another: "SO-1" would match the
   "SO-10" in the note, and "SO-2606-3" would match "SO-2606-33". Doc numbers are
   made of [A-Za-z0-9-], so we require that neither side of the match is flanked
   by another doc-number character — i.e. the token stands alone in the note
   (delimited by ": ", ", ", whitespace, or the string ends). The token is regex-
   escaped; the match is case-insensitive to mirror how numbers are written. */
const DOC_TOKEN_CHAR = /[A-Za-z0-9-]/;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* EXTRACT the SO doc numbers a PO's "From SOs: …" note records — the reverse of
   noteMentionsToken (membership) for callers that need the tokens themselves
   (e.g. resolving a single PO's origin SO(s) without scanning every company SO).
   Co-located here so the note FORMAT lives in exactly one place: the writer is
   `From SOs: ${docNos.join(', ')}` (mfg-purchase-orders.ts), so we match that
   leading label (case-insensitive, optional plural) and split the list on
   commas. Tokens are the doc numbers verbatim (company prefix already stripped
   by the writer); the caller VALIDATES them against real SOs by an equality
   lookup, which is what enforces whole-token matching — a split token "SO-1"
   can only ever equal the SO "SO-1", never "SO-10". Returns [] for a note with
   no "From SOs:" label (a plain free-text note). */
export const parseFromSosNote = (note: string | null | undefined): string[] => {
  if (!note) return [];
  const m = /^\s*From SOs?:\s*(.+)$/im.exec(String(note).trim());
  if (!m) return [];
  return [...new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean))];
};

export const noteMentionsToken = (note: string, token: string): boolean => {
  if (!note || !token) return false;
  // (?<![A-Za-z0-9-]) TOKEN (?![A-Za-z0-9-]) — TOKEN not adjacent to another
  // doc-number char on either side, so "SO-1" never matches inside "SO-10".
  const re = new RegExp(`(?<!${DOC_TOKEN_CHAR.source})${escapeRegExp(token)}(?!${DOC_TOKEN_CHAR.source})`, 'i');
  return re.test(note);
};

/* Resolve the set of Sales Order doc_nos the anchor document descends from.
   Every by-id / by-anchor read is scoped to the ACTIVE company via
   scopeToCompany (same idiom the sibling SCM routes use), so a caller in
   company A can never resolve a root SO from company B's document by feeding an
   enumerated id — the anchor read simply returns nothing for a foreign id.
   All tables touched here carry company_id (migration 0083). scopeToCompany
   no-ops when the active company is unresolved (pre-migration / cold-start). */
async function resolveRootSos(sb: any, c: Context<any>, type: NodeType, id: string): Promise<string[]> {
  switch (type) {
    case 'so':
      return [id];
    case 'do': {
      const { data } = await scopeToCompany(sb.from('delivery_orders').select('so_doc_no').eq('id', id), c).maybeSingle();
      if (data?.so_doc_no) return [data.so_doc_no];
      const { data: lines } = await scopeToCompany(sb.from('delivery_order_items').select('so_item_id').eq('delivery_order_id', id), c);
      return soDocNosFromSoItems(sb, c, uniq((lines ?? []).map((l: any) => l.so_item_id)));
    }
    case 'si': {
      const { data } = await scopeToCompany(sb.from('sales_invoices').select('so_doc_no, delivery_order_id').eq('id', id), c).maybeSingle();
      if (data?.so_doc_no) return [data.so_doc_no];
      if (data?.delivery_order_id) return resolveRootSos(sb, c, 'do', data.delivery_order_id);
      const { data: lines } = await scopeToCompany(sb.from('sales_invoice_items').select('so_item_id, do_item_id').eq('sales_invoice_id', id), c);
      const soItems = uniq((lines ?? []).map((l: any) => l.so_item_id));
      if (soItems.length) return soDocNosFromSoItems(sb, c, soItems);
      const doItems = uniq((lines ?? []).map((l: any) => l.do_item_id));
      return soDocNosFromDoItems(sb, c, doItems);
    }
    case 'payment': {
      const { data } = await scopeToCompany(sb.from('sales_invoice_payments').select('sales_invoice_id').eq('id', id), c).maybeSingle();
      return data?.sales_invoice_id ? resolveRootSos(sb, c, 'si', data.sales_invoice_id) : [];
    }
    case 'po': {
      const { data: lines } = await scopeToCompany(sb.from('purchase_order_items').select('so_item_id').eq('purchase_order_id', id), c);
      return soDocNosFromSoItems(sb, c, uniq((lines ?? []).map((l: any) => l.so_item_id)));
    }
    case 'grn': {
      const { data } = await scopeToCompany(sb.from('grns').select('purchase_order_id').eq('id', id), c).maybeSingle();
      return data?.purchase_order_id ? resolveRootSos(sb, c, 'po', data.purchase_order_id) : [];
    }
    case 'pi': {
      const { data } = await scopeToCompany(sb.from('purchase_invoices').select('grn_id').eq('id', id), c).maybeSingle();
      return data?.grn_id ? resolveRootSos(sb, c, 'grn', data.grn_id) : [];
    }
    case 'dr': {
      // Delivery Return hangs off its Delivery Order — resolve through the DO.
      const { data } = await scopeToCompany(sb.from('delivery_returns').select('delivery_order_id').eq('id', id), c).maybeSingle();
      return data?.delivery_order_id ? resolveRootSos(sb, c, 'do', data.delivery_order_id) : [];
    }
    case 'pr': {
      // Purchase Return hangs off its Goods Receipt (or, failing that, its PO).
      const { data } = await scopeToCompany(sb.from('purchase_returns').select('grn_id, purchase_order_id').eq('id', id), c).maybeSingle();
      if (data?.grn_id) return resolveRootSos(sb, c, 'grn', data.grn_id);
      return data?.purchase_order_id ? resolveRootSos(sb, c, 'po', data.purchase_order_id) : [];
    }
    default:
      return [];
  }
}

async function soDocNosFromSoItems(sb: any, c: Context<any>, soItemIds: string[]): Promise<string[]> {
  if (soItemIds.length === 0) return [];
  const { data } = await scopeToCompany(sb.from('mfg_sales_order_items').select('doc_no').in('id', soItemIds), c);
  return uniq((data ?? []).map((r: any) => r.doc_no));
}
async function soDocNosFromDoItems(sb: any, c: Context<any>, doItemIds: string[]): Promise<string[]> {
  if (doItemIds.length === 0) return [];
  const { data } = await scopeToCompany(sb.from('delivery_order_items').select('so_item_id').in('id', doItemIds), c);
  return soDocNosFromSoItems(sb, c, uniq((data ?? []).map((r: any) => r.so_item_id)));
}

/* Self-contained graph for the consignment family. The consignment chains are
   NOT linked to the mfg Sales Order root, so they get their own rooted builder:
     sales:    cso (Consignment Order) ▶ cdo (Note) ▶ cdr (Return)
     purchase: pco (PC Order) ▶ pcr (PC Receive) ▶ pcrn (PC Return)
   FKs (confirmed against migrations 0153/0154):
     consignment_delivery_orders.consignment_so_doc_no
     consignment_delivery_order_items.consignment_so_item_id
     consignment_delivery_returns.consignment_do_id
     consignment_delivery_return_items.consignment_do_item_id
     purchase_consignment_receives.purchase_consignment_order_id
     purchase_consignment_receive_items.pc_order_item_id
     purchase_consignment_returns.pc_order_id / .pc_receive_id
     purchase_consignment_return_items.pc_receive_item_id                       */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildConsignmentFlow(sb: any, c: Context<any>, type: NodeType, id: string, cid: number | null) {
  const anchorKey = keyOf(type, id);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind });
  };
  const orphan = (rootSos: string[]) => {
    if (nodes.size === 0) nodes.set(anchorKey, { key: anchorKey, type, id, label: id, status: null, isAnchor: true });
    return { nodes: [...nodes.values()], edges, rootSos };
  };

  // ── SALES chain: cso ▶ cdo ▶ cdr ─────────────────────────────────────────
  if (type === 'cso' || type === 'cdo' || type === 'cdr') {
    let rootDoc: string | null = null;
    if (type === 'cso') rootDoc = id;
    else if (type === 'cdo') {
      // Scope the anchor read to the active company so a foreign id resolves to
      // no root (defence-in-depth on top of the root-ownership gate below).
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

    // Multi-company: only trace this consignment family if the ACTIVE company
    // owns the root order — otherwise collapse to the orphan anchor.
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

  // ── PURCHASE chain: pco ▶ pcr ▶ pcrn ─────────────────────────────────────
  let rootPco: string | null = null;
  if (type === 'pco') rootPco = id;
  else if (type === 'pcr') {
    // Scope the anchor read to the active company (defence-in-depth on top of
    // the root-ownership gate below).
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

  // Multi-company: only trace this PC family if the ACTIVE company owns the root
  // PC order — otherwise collapse to the orphan anchor.
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
  for (const l of (poLines ?? []) as any[]) poItemQty.set(l.id, Number(l.qty ?? 0));
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

/* ── GET /document-flow/candidate-pos/:soDocNo ──────────────────────────────
   ADVISORY, READ-ONLY. For an SO whose purchase leg was never linked
   (purchase_order_items.so_item_id NULL — every PO raised before the MRP-linked
   flow of 2026-07-09), surface the live POs that MIGHT cover it, matched by
   material_code ALONE. This writes NOTHING and creates NO link: a pre-MRP PO was
   a shared stock buy (one PO, qty N, feeding several SOs), so the true SO⇄PO
   attribution was never recorded and cannot be safely inferred. The map shows
   these as "Not linked from this SO" so the office can reconcile by hand without
   the graph ever asserting a guess as fact.

   Registered BEFORE the '/:type/:id' catch-all so 'candidate-pos' is not parsed
   as a NodeType. Company-scoped both ends: gated on SO ownership, and the PO
   read itself is scopeToCompany'd. */
documentFlow.get('/candidate-pos/:soDocNo', async (c) => {
  const sb = c.get('supabase');
  const soDocNo = c.req.param('soDocNo');
  const cid = activeCompanyId(c);

  // Ownership gate — never resolve candidates for an SO another company owns.
  if (cid != null) {
    const { data: so } = await sb.from('mfg_sales_orders')
      .select('doc_no').eq('doc_no', soDocNo).eq('company_id', cid).maybeSingle();
    if (!so) return c.json({ candidates: [] });
  }

  // The SO's own item codes (doc_no already company-verified above).
  const { data: soItems } = await sb.from('mfg_sales_order_items')
    .select('item_code').eq('doc_no', soDocNo);
  const codes = uniq((soItems ?? []).map((r: any) => r.item_code));
  if (codes.length === 0) return c.json({ candidates: [] });

  // UNLINKED PO lines (so_item_id NULL) carrying any of those codes.
  const { data: poItems } = await sb.from('purchase_order_items')
    .select('purchase_order_id')
    .in('material_code', codes)
    .is('so_item_id', null);
  const poIds = uniq((poItems ?? []).map((r: any) => r.purchase_order_id));
  if (poIds.length === 0) return c.json({ candidates: [] });

  // Live (non-CANCELLED) POs only, company-scoped, newest first.
  const { data: pos } = await scopeToCompany(
    sb.from('purchase_orders')
      .select('id, po_number, status, po_date')
      .in('id', poIds)
      .neq('status', 'CANCELLED'),
    c,
  );
  const candidates = ((pos ?? []) as any[])
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

  // Multi-company: the graph is isolated to the ACTIVE company. Resolved once
  // here and threaded into both the consignment builder and the SO-root filter.
  const cid = activeCompanyId(c);

  // Consignment docs form their own self-contained family graph.
  if (CONSIGNMENT_TYPES.includes(type)) {
    return c.json(await buildConsignmentFlow(sb, c, type, id, cid ?? null));
  }

  let rootSos = await resolveRootSos(sb, c, type, id);

  // The ENTIRE relationship graph descends from these root SOs (every downstream
  // read is bounded by `.in('doc_no', rootSos)` or by SO-item ids derived from
  // them). Filter the roots to the SOs the active company owns, so a caller in
  // company A can never trace / leak company B's document family. If none of the
  // roots belong to the active company, the graph collapses to the orphan branch
  // below (just the anchor the caller already named). No-op when the active
  // company is unresolved (pre-migration / cold-start).
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
  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind });
  };

  if (rootSos.length === 0) {
    // Orphan document with no resolvable SO — still show it alone so the map
    // is never blank. (Rare: an ad-hoc invoice with no SO/DO link.)
    nodes.set(anchorKey, { key: anchorKey, type, id, label: id, status: null, isAnchor: true });
    return c.json({ nodes: [...nodes.values()], edges, rootSos, amendments: [] });
  }

  // ── 1. SO headers + lines ───────────────────────────────────────────────
  const { data: soHeaders } = await sb.from('mfg_sales_orders').select('doc_no, status').in('doc_no', rootSos);
  for (const s of (soHeaders ?? []) as any[]) {
    const k = keyOf('so', s.doc_no);
    nodes.set(k, { key: k, type: 'so', id: s.doc_no, label: s.doc_no, status: s.status ?? null, isAnchor: k === anchorKey });
  }
  const { data: soLines } = await sb.from('mfg_sales_order_items').select('id, doc_no, qty').in('doc_no', rootSos);
  const soItemQty = new Map<string, number>();   // soItemId → qty
  const soItemToDoc = new Map<string, string>(); // soItemId → SO doc_no
  for (const l of (soLines ?? []) as any[]) {
    soItemQty.set(l.id, Number(l.qty ?? 0));
    soItemToDoc.set(l.id, l.doc_no);
  }
  const soItemIds = [...soItemQty.keys()];

  // ── 2. DOs (sales chain) ────────────────────────────────────────────────
  const doLinesBySoItem = soItemIds.length
    ? (await sb.from('delivery_order_items').select('id, delivery_order_id, so_item_id, qty').in('so_item_id', soItemIds)).data ?? []
    : [];
  const { data: doByHeader } = await sb.from('delivery_orders').select('id, do_number, status, so_doc_no').in('so_doc_no', rootSos);
  const doIds = uniq([
    ...((doByHeader ?? []) as any[]).map((d) => d.id),
    ...((doLinesBySoItem) as any[]).map((l) => l.delivery_order_id),
  ]);
  const doHeaderById = new Map<string, any>();
  for (const d of (doByHeader ?? []) as any[]) doHeaderById.set(d.id, d);
  const missingDoIds = doIds.filter((d) => !doHeaderById.has(d));
  if (missingDoIds.length) {
    const { data: more } = await sb.from('delivery_orders').select('id, do_number, status, so_doc_no').in('id', missingDoIds);
    for (const d of (more ?? []) as any[]) doHeaderById.set(d.id, d);
  }
  // do line id → { doId, qty, soItemId } ; and per-DO coverage vs SO
  const doItemMeta = new Map<string, { doId: string; qty: number; soItemId: string | null }>();
  const soToDo = new Map<string, { childQty: number; parentItems: Set<string> }>(); // `${soDocNo}|${doId}`
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
  // SO → DO edges
  for (const d of doHeaderById.values()) {
    const soDoc = d.so_doc_no && rootSos.includes(d.so_doc_no) ? d.so_doc_no : rootSos.find((s) => soToDo.has(`${s}|${d.id}`));
    if (!soDoc) continue;
    const agg = soToDo.get(`${soDoc}|${d.id}`);
    const parentQty = agg ? [...agg.parentItems].reduce((s, si) => s + (soItemQty.get(si) ?? 0), 0) : 0;
    addEdge(keyOf('so', soDoc), keyOf('do', d.id), agg ? cover(agg.childQty, parentQty) : 'full');
  }

  // ── 3. Sales Invoices ───────────────────────────────────────────────────
  const doItemIds = [...doItemMeta.keys()];
  const siByHeaderDo = doIds.length
    ? (await sb.from('sales_invoices').select('id, invoice_number, status, so_doc_no, delivery_order_id').in('delivery_order_id', doIds)).data ?? []
    : [];
  const { data: siBySoDoc } = await sb.from('sales_invoices').select('id, invoice_number, status, so_doc_no, delivery_order_id').in('so_doc_no', rootSos);
  const siLineLinks = doItemIds.length
    ? (await sb.from('sales_invoice_items').select('sales_invoice_id, do_item_id, so_item_id, qty').in('do_item_id', doItemIds)).data ?? []
    : [];
  const siById = new Map<string, any>();
  for (const s of [...(siByHeaderDo as any[]), ...((siBySoDoc ?? []) as any[])]) siById.set(s.id, s);
  // pull SIs reachable only through line links
  const lineSiIds = uniq((siLineLinks as any[]).map((l) => l.sales_invoice_id)).filter((sid) => !siById.has(sid));
  if (lineSiIds.length) {
    const { data: more } = await sb.from('sales_invoices').select('id, invoice_number, status, so_doc_no, delivery_order_id').in('id', lineSiIds);
    for (const s of (more ?? []) as any[]) siById.set(s.id, s);
  }
  for (const s of siById.values()) {
    const k = keyOf('si', s.id);
    nodes.set(k, { key: k, type: 'si', id: s.id, label: s.invoice_number ?? s.id, status: s.status ?? null, isAnchor: k === anchorKey });
  }
  // DO → SI coverage from line links: `${doId}|${siId}`
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
    // SI tied straight to the SO (no DO in between)
    if (!linked && s.so_doc_no && rootSos.includes(s.so_doc_no)) {
      addEdge(keyOf('so', s.so_doc_no), keyOf('si', s.id), 'full');
    }
  }

  // ── 4. AR Payments ──────────────────────────────────────────────────────
  const siIds = [...siById.keys()];
  if (siIds.length) {
    const { data: pays } = await sb.from('sales_invoice_payments')
      .select('id, sales_invoice_id, method, approval_code, amount_centi').in('sales_invoice_id', siIds);
    for (const p of (pays ?? []) as any[]) {
      const k = keyOf('payment', p.id);
      const label = p.approval_code?.trim() ? p.approval_code.trim() : `${(p.method ?? 'Payment')} ${(Number(p.amount_centi ?? 0) / 100).toFixed(0)}`;
      nodes.set(k, { key: k, type: 'payment', id: p.id, label, status: null, isAnchor: k === anchorKey });
      addEdge(keyOf('si', p.sales_invoice_id), k, 'payment');
    }
  }

  // ── 8. Delivery Returns (sales chain) ───────────────────────────────────
  // A Delivery Return reverses goods on a Delivery Order. It hangs off the DO,
  // mirroring how a GRN hangs off its PO. Coverage compares returned qty to the
  // DO line qty (a full return greys out blue, a partial one red).
  if (doIds.length) {
    const { data: drByHeader } = await sb.from('delivery_returns')
      .select('id, return_number, status, delivery_order_id').in('delivery_order_id', doIds);
    const drIds = uniq((drByHeader ?? []).map((d: any) => d.id));
    const drLineLinks = drIds.length
      ? (await sb.from('delivery_return_items').select('delivery_return_id, do_item_id, qty_returned').in('delivery_return_id', drIds)).data ?? []
      : [];
    const doToDr = new Map<string, { childQty: number; parentItems: Set<string> }>(); // `${doId}|${drId}`
    for (const l of (drLineLinks as any[])) {
      const dm = l.do_item_id ? doItemMeta.get(l.do_item_id) : undefined;
      if (!dm) continue;
      const k = `${dm.doId}|${l.delivery_return_id}`;
      const agg = doToDr.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty_returned ?? 0);
      agg.parentItems.add(l.do_item_id);
      doToDr.set(k, agg);
    }
    for (const d of (drByHeader ?? []) as any[]) {
      const k = keyOf('dr', d.id);
      nodes.set(k, { key: k, type: 'dr', id: d.id, label: d.return_number ?? d.id, status: d.status ?? null, isAnchor: k === anchorKey });
      if (d.delivery_order_id) {
        const agg = doToDr.get(`${d.delivery_order_id}|${d.id}`);
        const parentQty = agg ? [...agg.parentItems].reduce((s, di) => s + (doItemMeta.get(di)?.qty ?? 0), 0) : 0;
        addEdge(keyOf('do', d.delivery_order_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
      }
    }
  }

  // ── 5. POs (purchase chain) ─────────────────────────────────────────────
  // Two linkage sources, both real:
  //   (a) so_item_id — the MRP-linked flow (2026-07-09 onward). Per-item, exact.
  //   (b) the PO's "From SOs: …" note — how a PO records its source SO(s) at
  //       creation. It is the ONLY link for POs raised before so_item_id existed
  //       (a shared stock buy stamps every SO it was raised for), and it is an
  //       authoritative record, not a guess — so note-linked POs are surfaced as
  //       REAL nodes, and their GRN/PI chain expands through the header FKs below
  //       exactly like a so_item_id-linked PO's does.
  const poItemLinks = soItemIds.length
    ? (await sb.from('purchase_order_items').select('id, purchase_order_id, so_item_id, qty').in('so_item_id', soItemIds)).data ?? []
    : [];
  const poItemMeta = new Map<string, { poId: string; qty: number }>();
  for (const l of (poItemLinks as any[])) poItemMeta.set(l.id, { poId: l.purchase_order_id, qty: Number(l.qty ?? 0) });

  /* (b) Note-recorded links. The note drops the company prefix ("2990-SO-2606-033"
     is written "SO-2606-033"), so match on the prefix-stripped token. Company-
     scoped: only the active company's POs are scanned. `noteEdges` collects the
     SO→PO pairs the note asserts so the value edge is drawn even though these POs
     carry no so_item_id. */
  const bareTokens = rootSos.map((d) => stripCompanyPrefix(d)).filter(Boolean);
  const noteEdges: Array<{ soDoc: string; poId: string }> = [];
  const notePoIds: string[] = [];
  if (cid != null && bareTokens.length) {
    const { data: notedPos } = await sb.from('purchase_orders')
      .select('id, notes').eq('company_id', cid).not('notes', 'is', null);
    for (const p of (notedPos ?? []) as any[]) {
      const note = String(p.notes ?? '');
      let matched = false;
      for (let i = 0; i < rootSos.length; i++) {
        const t = bareTokens[i];
        if (t && noteMentionsToken(note, t)) { noteEdges.push({ soDoc: rootSos[i]!, poId: p.id }); matched = true; }
      }
      if (matched) notePoIds.push(p.id);
    }
  }

  const poIds = uniq([...(poItemLinks as any[]).map((l) => l.purchase_order_id), ...notePoIds]);
  if (poIds.length) {
    const { data: pos } = await sb.from('purchase_orders').select('id, po_number, status').in('id', poIds);
    for (const p of (pos ?? []) as any[]) {
      const k = keyOf('po', p.id);
      nodes.set(k, { key: k, type: 'po', id: p.id, label: p.po_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
    }
    // SO → PO: a purchase raised against the SO is a value transfer.
    const poToSo = new Map<string, Set<string>>(); // poId → soDocNos
    for (const l of (poItemLinks as any[])) {
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
    for (const [poId, soDocs] of poToSo) for (const soDoc of soDocs) addEdge(keyOf('so', soDoc), keyOf('po', poId), 'value');
  }

  // ── 6. GRNs ─────────────────────────────────────────────────────────────
  const poItemIds = [...poItemMeta.keys()];
  const grnByHeader = poIds.length
    ? (await sb.from('grns').select('id, grn_number, status, purchase_order_id').in('purchase_order_id', poIds)).data ?? []
    : [];
  const grnLineLinks = poItemIds.length
    ? (await sb.from('grn_items').select('id, grn_id, purchase_order_item_id, qty').in('purchase_order_item_id', poItemIds)).data ?? []
    : [];
  const grnById = new Map<string, any>();
  for (const g of (grnByHeader as any[])) grnById.set(g.id, g);
  const grnItemMeta = new Map<string, { grnId: string; qty: number }>();
  const poToGrn = new Map<string, { childQty: number; parentItems: Set<string> }>(); // `${poId}|${grnId}`
  for (const l of (grnLineLinks as any[])) {
    grnItemMeta.set(l.id, { grnId: l.grn_id, qty: Number(l.qty ?? 0) });
    const pm = poItemMeta.get(l.purchase_order_item_id);
    if (!pm) continue;
    const k = `${pm.poId}|${l.grn_id}`;
    const agg = poToGrn.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
    agg.childQty += Number(l.qty ?? 0);
    agg.parentItems.add(l.purchase_order_item_id);
    poToGrn.set(k, agg);
  }
  for (const g of grnById.values()) {
    const k = keyOf('grn', g.id);
    nodes.set(k, { key: k, type: 'grn', id: g.id, label: g.grn_number ?? g.id, status: g.status ?? null, isAnchor: k === anchorKey });
    if (g.purchase_order_id) {
      const agg = poToGrn.get(`${g.purchase_order_id}|${g.id}`);
      const parentQty = agg ? [...agg.parentItems].reduce((s, pi) => s + (poItemMeta.get(pi)?.qty ?? 0), 0) : 0;
      addEdge(keyOf('po', g.purchase_order_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
    }
  }

  // ── 7. Purchase Invoices ────────────────────────────────────────────────
  const grnIds = [...grnById.keys()];
  const grnItemIds = [...grnItemMeta.keys()];
  if (grnIds.length) {
    const { data: pis } = await sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('grn_id', grnIds);
    const piLineLinks = grnItemIds.length
      ? (await sb.from('purchase_invoice_items').select('purchase_invoice_id, grn_item_id, qty').in('grn_item_id', grnItemIds)).data ?? []
      : [];
    const grnToPi = new Map<string, { childQty: number; parentItems: Set<string> }>();
    for (const l of (piLineLinks as any[])) {
      const gm = l.grn_item_id ? grnItemMeta.get(l.grn_item_id) : undefined;
      if (!gm) continue;
      const k = `${gm.grnId}|${l.purchase_invoice_id}`;
      const agg = grnToPi.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty ?? 0);
      agg.parentItems.add(l.grn_item_id);
      grnToPi.set(k, agg);
    }
    for (const p of (pis ?? []) as any[]) {
      const k = keyOf('pi', p.id);
      nodes.set(k, { key: k, type: 'pi', id: p.id, label: p.invoice_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
      if (p.grn_id) {
        const agg = grnToPi.get(`${p.grn_id}|${p.id}`);
        const parentQty = agg ? [...agg.parentItems].reduce((s, gi) => s + (grnItemMeta.get(gi)?.qty ?? 0), 0) : 0;
        addEdge(keyOf('grn', p.grn_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
      }
    }
  }

  // ── 9. Purchase Returns (purchase chain) ────────────────────────────────
  // A Purchase Return reverses goods on a Goods Receipt. It hangs off the GRN,
  // mirroring how a Delivery Return hangs off its DO. Coverage compares returned
  // qty to the GRN line qty.
  if (grnIds.length) {
    const { data: prByHeader } = await sb.from('purchase_returns')
      .select('id, return_number, status, grn_id').in('grn_id', grnIds);
    const prIds = uniq((prByHeader ?? []).map((p: any) => p.id));
    const prLineLinks = prIds.length
      ? (await sb.from('purchase_return_items').select('purchase_return_id, grn_item_id, qty_returned').in('purchase_return_id', prIds)).data ?? []
      : [];
    const grnToPr = new Map<string, { childQty: number; parentItems: Set<string> }>(); // `${grnId}|${prId}`
    for (const l of (prLineLinks as any[])) {
      const gm = l.grn_item_id ? grnItemMeta.get(l.grn_item_id) : undefined;
      if (!gm) continue;
      const k = `${gm.grnId}|${l.purchase_return_id}`;
      const agg = grnToPr.get(k) ?? { childQty: 0, parentItems: new Set<string>() };
      agg.childQty += Number(l.qty_returned ?? 0);
      agg.parentItems.add(l.grn_item_id);
      grnToPr.set(k, agg);
    }
    for (const p of (prByHeader ?? []) as any[]) {
      const k = keyOf('pr', p.id);
      nodes.set(k, { key: k, type: 'pr', id: p.id, label: p.return_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
      if (p.grn_id) {
        const agg = grnToPr.get(`${p.grn_id}|${p.id}`);
        const parentQty = agg ? [...agg.parentItems].reduce((s, gi) => s + (grnItemMeta.get(gi)?.qty ?? 0), 0) : 0;
        addEdge(keyOf('grn', p.grn_id), k, agg ? cover(agg.childQty, parentQty) : 'full');
      }
    }
  }

  // ── 10. SO amendments (revision requests) ────────────────────────────────
  // Amendments hang off the SO by so_doc_no. They are surfaced as a read-only
  // side list (not graph nodes) so the relationship map can branch them off the
  // Sales Order, each clickable to /scm/amendments/:id. Company scope is already
  // enforced: rootSos was filtered to the active company's owned SOs above, so a
  // join on so_doc_no can only ever reach this company's amendments. PO
  // amendments do not exist as their own document — a PO revision is the PO leg
  // of an SO amendment (approve-po → po_revisions) — so there is nothing extra
  // to surface off the PO.
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

  return c.json({ nodes: [...nodes.values()], edges, rootSos, amendments });
});

export default documentFlow;
