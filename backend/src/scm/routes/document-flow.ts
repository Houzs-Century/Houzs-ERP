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
import { chunkIn } from '../lib/paginate-all';
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
type EdgeLinkage = 'chain' | 'provenance';

const CONSIGNMENT_TYPES: NodeType[] = ['cso', 'cdo', 'cdr', 'pco', 'pcr', 'pcrn'];

type FlowNode = {
  key: string;            // unique `${type}:${id}`
  type: NodeType;
  id: string;             // navigation key (doc_no for SO, uuid for the rest)
  label: string;          // human document number
  status: string | null;
  isAnchor: boolean;
};
type FlowEdge = { from: string; to: string; kind: EdgeKind; linkage: EdgeLinkage };

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
      const linked = await soDocNosFromSoItems(sb, c, uniq((lines ?? []).map((l: any) => l.so_item_id)));
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
      return data?.purchase_order_id ? resolveRootSos(sb, c, 'po', data.purchase_order_id) : [];
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
        const { data: gis } = await sb.from('grn_items').select('grn_id').in('id', grnItemIds);
        grnIds.push(...uniq(((gis ?? []) as Array<{ grn_id: string | null }>).map((r) => r.grn_id)));
      }
      if (grnIds.length) {
        const all = await Promise.all(grnIds.map((gid) => resolveRootSos(sb, c, 'grn', gid)));
        return uniq(all.flat());
      }
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
  // Consignment chains are execution FKs end to end — every edge is 'chain'.
  const addEdge = (from: string, to: string, kind: EdgeKind) => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind, linkage: 'chain' });
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
   item_code ALONE. This writes NOTHING and creates NO link: a pre-MRP PO was
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
    .in('item_code', codes)
    .is('so_item_id', null);
  const poIds = uniq((poItems ?? []).map((r: any) => r.purchase_order_id));
  if (poIds.length === 0) return c.json({ candidates: [] });

  /* Live (non-CANCELLED) POs only, company-scoped, newest first. CHUNKED: the
     read above collects EVERY unlinked PO line carrying one of this order's item
     codes, with no date or status bound, so `poIds` grows with the whole PO
     history of a common SKU rather than with this one order. The `.sort()` below
     is a total order over the merged rows, so batching cannot reshuffle the
     candidate list. */
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
  // Default 'chain' — every edge below is an execution FK except the SO ▶ PO
  // raise-link, whose one callsite stamps 'provenance' explicitly.
  const addEdge = (from: string, to: string, kind: EdgeKind, linkage: EdgeLinkage = 'chain') => {
    if (nodes.has(from) && nodes.has(to)) edges.push({ from, to, kind, linkage });
  };

  if (rootSos.length === 0) {
    // Orphan document with no resolvable SO — still show it alone so the map
    // is never blank. (Rare: an ad-hoc invoice with no SO/DO link.)
    nodes.set(anchorKey, { key: anchorKey, type, id, label: id, status: null, isAnchor: true });

    /* …except a PURCHASE ORDER (owner 2026-07-27): a stock buy / unlinked PO is
       still the head of its own receipt chain — grns.purchase_order_id hangs off
       the PO regardless of any SO, and hiding those painted "Not created" over
       real receipts (the same lying-node class audit R8 killed on the sales
       maps). So a PO anchor expands its own downstream (PO ▶ GRN ▶ PI / PR)
       before returning; every other orphan type keeps the lone-anchor shape.
       Reads mirror sections 6/7/9 below and are company-scoped on the PO/GRN
       hops, so a foreign PO id still collapses to the bare anchor. The GRN edge
       keeps real partial/full coverage; PI/PR edges default 'full' (coverage
       colouring matters on the receipt hop — billing splits on a stock buy are
       cosmetic). */
    let poAmendments: Array<{ id: string; poId: string; poNumber: string; amendmentNo: number | string; status: string | null; createdAt: string | null }> = [];
    if (type === 'po') {
      const { data: poHdr } = await scopeToCompany(sb.from('purchase_orders').select('po_number, status').eq('id', id), c).maybeSingle();
      if (poHdr) {
        nodes.set(anchorKey, { key: anchorKey, type, id, label: poHdr.po_number ?? id, status: poHdr.status ?? null, isAnchor: true });
      }
      const { data: poLines } = await scopeToCompany(sb.from('purchase_order_items').select('id, qty').eq('purchase_order_id', id), c);
      const poItemQty = new Map<string, number>();
      for (const l of (poLines ?? []) as any[]) poItemQty.set(l.id, Number(l.qty ?? 0));

      const { data: grnHdrs } = await scopeToCompany(sb.from('grns').select('id, grn_number, status').eq('purchase_order_id', id), c);
      const grnIds = uniq(((grnHdrs ?? []) as any[]).map((g) => g.id));
      const grnLines = grnIds.length
        ? (await sb.from('grn_items').select('grn_id, purchase_order_item_id, qty').in('grn_id', grnIds)).data ?? []
        : [];
      const poToGrn = new Map<string, { childQty: number; parentItems: Set<string> }>();
      for (const l of (grnLines as any[])) {
        if (!l.purchase_order_item_id || !poItemQty.has(l.purchase_order_item_id)) continue;
        const agg = poToGrn.get(l.grn_id) ?? { childQty: 0, parentItems: new Set<string>() };
        agg.childQty += Number(l.qty ?? 0);
        agg.parentItems.add(l.purchase_order_item_id);
        poToGrn.set(l.grn_id, agg);
      }
      for (const g of (grnHdrs ?? []) as any[]) {
        const k = keyOf('grn', g.id);
        nodes.set(k, { key: k, type: 'grn', id: g.id, label: g.grn_number ?? g.id, status: g.status ?? null, isAnchor: false });
        const agg = poToGrn.get(g.id);
        const parentQty = agg ? [...agg.parentItems].reduce((s, pi) => s + (poItemQty.get(pi) ?? 0), 0) : 0;
        addEdge(anchorKey, k, agg ? cover(agg.childQty, parentQty) : 'full');
      }
      if (grnIds.length) {
        /* Multi-GRN PIs — same union as the main builder: a PI reaches this
           family through its LINES even when its header names another note. */
        const { data: myGrnItems } = await sb.from('grn_items').select('id, grn_id').in('grn_id', grnIds);
        const myGrnItemIds = ((myGrnItems ?? []) as Array<{ id: string }>).map((r) => r.id);
        const grnIdByItem = new Map(((myGrnItems ?? []) as Array<{ id: string; grn_id: string }>).map((r) => [r.id, r.grn_id]));
        const { data: piLineLinks } = myGrnItemIds.length
          ? await sb.from('purchase_invoice_items').select('purchase_invoice_id, grn_item_id').in('grn_item_id', myGrnItemIds)
          : { data: [] as any[] };
        const notesByPi = new Map<string, Set<string>>();
        for (const l of ((piLineLinks ?? []) as any[])) {
          const gid = l.grn_item_id ? grnIdByItem.get(l.grn_item_id) : undefined;
          if (!gid) continue;
          const set = notesByPi.get(l.purchase_invoice_id) ?? new Set<string>();
          set.add(gid);
          notesByPi.set(l.purchase_invoice_id, set);
        }
        const { data: pisByHeader } = await sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('grn_id', grnIds);
        const seen = new Set((pisByHeader ?? []).map((p: any) => p.id));
        const extraIds = [...notesByPi.keys()].filter((pid) => !seen.has(pid));
        const { data: pisByLine } = extraIds.length
          ? await sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('id', extraIds)
          : { data: [] as any[] };
        for (const p of [...((pisByHeader ?? []) as any[]), ...((pisByLine ?? []) as any[])]) {
          const k = keyOf('pi', p.id);
          nodes.set(k, { key: k, type: 'pi', id: p.id, label: p.invoice_number ?? p.id, status: p.status ?? null, isAnchor: false });
          const notes = notesByPi.get(p.id);
          if (notes?.size) for (const gid of notes) addEdge(keyOf('grn', gid), k, 'full');
          else if (p.grn_id) addEdge(keyOf('grn', p.grn_id), k, 'full');
        }
        const { data: prs } = await sb.from('purchase_returns').select('id, return_number, status, grn_id').in('grn_id', grnIds);
        for (const p of (prs ?? []) as any[]) {
          const k = keyOf('pr', p.id);
          nodes.set(k, { key: k, type: 'pr', id: p.id, label: p.return_number ?? p.id, status: p.status ?? null, isAnchor: false });
          if (p.grn_id) addEdge(keyOf('grn', p.grn_id), k, 'full');
        }
      }
      // PO amendments still branch off an orphan PO (same shape as section 11).
      const { data: poAmendRows } = await sb.from('po_amendments')
        .select('id, po_id, po_number, amendment_no, status, created_at')
        .eq('po_id', id)
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
    return c.json({ nodes: [...nodes.values()], edges, rootSos, amendments: [], poAmendments });
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
      .select('id, sales_invoice_id, method, approval_code, amount_sen').in('sales_invoice_id', siIds);
    for (const p of (pays ?? []) as any[]) {
      const k = keyOf('payment', p.id);
      const label = p.approval_code?.trim() ? p.approval_code.trim() : `${(p.method ?? 'Payment')} ${(Number(p.amount_sen ?? 0) / 100).toFixed(0)}`;
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

  /* (b) Note-recorded links. Notes exist in BOTH shapes and both are real:
     the writer stamps the SO doc number VERBATIM (mfg-purchase-orders.ts:
     `From SOs: ${docNos.join(', ')}`), so a 2990 PO raised in Houzs records
     "2990-SO-2607-016"; but the 2990 IMPORT left its historical notes naming
     the PRE-IMPORT number "SO-2606-033", because migrate-2990-into-houzs.mjs
     prefixed doc-number columns and not free text inside `notes`.
     repair-2990-doc-refs.mjs corrects those it can PROVE, and deliberately
     leaves the ambiguous ones alone — so both shapes will coexist permanently
     and this matcher has to accept either.

     Matching only the prefix-stripped token (which is all this did) breaks on a
     prefixed note: noteMentionsToken forbids an adjacent doc-number character,
     and the "-" of "2990-" is one, so "SO-2607-016" does NOT match inside
     "2990-SO-2607-016". Try the FULL doc number first, then the bare tail.

     Both are safe against the colliding-tail hazard for the same reason as
     before: the scan is `.eq('company_id', cid)`, so a bare token can only ever
     match a note on a PO in the SAME company as the root SO. */
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

  /* FK-over-note (clobber-residue guard). A PO that carries ANY so_item_id line
     is a modern, FK-linked purchase; its "From SOs: …" note is legacy free text,
     authoritative only for pre-so_item_id POs with no hard link at all. When a
     reused SO doc_no lingers in such a note (a rebuilt SO taking over a number a
     since-renumbered order once held), the token match wrongly drags that PO's
     whole received chain onto the SO now holding the number. So drop the note
     edges for any PO that has a hard so_item_id link — the poItemLinks above are
     its real provenance. Bounded by notePoIds (POs whose note already matched a
     root SO), so this adds one small read only when notes matched at all. */
  if (notePoIds.length) {
    const { data: fkRows, error: fkErr } = await sb.from('purchase_order_items')
      .select('purchase_order_id')
      .in('purchase_order_id', uniq(notePoIds))
      .not('so_item_id', 'is', null);
    /* On a read failure leave the note edges untouched rather than guess — the
       map is advisory and this FK-over-note guard is an enhancement, not a
       correctness gate. */
    if (!fkErr) {
      const fkLinkedPoIds = new Set((fkRows ?? []).map((r: any) => r.purchase_order_id as string));
      if (fkLinkedPoIds.size) {
        const kept = noteEdges.filter((e) => !fkLinkedPoIds.has(e.poId));
        noteEdges.length = 0;
        noteEdges.push(...kept);
        notePoIds.length = 0;
        notePoIds.push(...uniq(kept.map((e) => e.poId)));
      }
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
    // The SO ▶ PO raise-link is PROVENANCE, not execution ("soft until DO,
    // hard from DO"): it records why we bought and binds nothing downstream.
    for (const [poId, soDocs] of poToSo) for (const soDoc of soDocs) addEdge(keyOf('so', soDoc), keyOf('po', poId), 'value', 'provenance');
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
    /* Multi-GRN PIs (owner 2026-08-06): one supplier invoice can bill several
       notes, so the header's grn_id is just the primary ref. Discover PIs by
       the LINE link (grn_item_id ∈ this family's GRN lines) UNION the header
       FK — a header-only match still appears (e.g. a PI whose lines were all
       deleted), and a PI whose header points at another family's note is no
       longer invisible here. */
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
    const piIdsFromLines = uniq((piLineLinks as any[]).map((l) => l.purchase_invoice_id));
    const { data: pisByHeader } = await sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('grn_id', grnIds);
    const knownPiIds = new Set((pisByHeader ?? []).map((p: any) => p.id));
    const missingPiIds = piIdsFromLines.filter((pid) => !knownPiIds.has(pid));
    const { data: pisByLine } = missingPiIds.length
      ? await sb.from('purchase_invoices').select('id, invoice_number, status, grn_id').in('id', missingPiIds)
      : { data: [] as any[] };
    const pis = [...((pisByHeader ?? []) as any[]), ...((pisByLine ?? []) as any[])];
    for (const p of pis) {
      const k = keyOf('pi', p.id);
      nodes.set(k, { key: k, type: 'pi', id: p.id, label: p.invoice_number ?? p.id, status: p.status ?? null, isAnchor: k === anchorKey });
      /* One edge per NOTE this PI actually bills (from the line aggregation),
         so a 3-note invoice draws three GRN→PI edges, each with its own
         coverage. The header FK only supplies a fallback edge when the PI has
         no line links at all. */
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

  // ── 11. PO amendments (revision requests) ────────────────────────────────
  // The PO-side sibling of the SO amendment side list above (mig 0192). A PO
  // amendment IS its own document now (po_amendments) — not the PO leg of an SO
  // amendment — so it branches off the Purchase Order node(s), each clickable to
  // /scm/po-amendments/:id. Keyed by po_id against the PO nodes already in the
  // graph, which were themselves gathered from company-scoped reads, so this can
  // only ever reach this company's amendments (same scoping argument as the SO
  // block). Returned as a SEPARATE `poAmendments` array so the SO amendment
  // shape is untouched.
  const poIdsInGraph = [...nodes.values()].filter((n) => n.type === 'po').map((n) => n.id);
  let poAmendments: Array<{ id: string; poId: string; poNumber: string; amendmentNo: number | string; status: string | null; createdAt: string | null }> = [];
  if (poIdsInGraph.length > 0) {
    const { data: poAmendRows } = await sb.from('po_amendments')
      .select('id, po_id, po_number, amendment_no, status, created_at')
      .in('po_id', poIdsInGraph)
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

  return c.json({ nodes: [...nodes.values()], edges, rootSos, amendments, poAmendments });
});

export default documentFlow;
