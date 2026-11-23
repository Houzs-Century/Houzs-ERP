/* Rebuild the product changes of past months from each order's own history, for
   the record Finance reads (scm.so_product_changes, lib/so-product-change-record.ts
   writes it live). Owner 2026-11-23: 「补，从 9 月开始」.

   WHERE THE HISTORY IS. An order's lines as they are now, walked BACK through
   scm.mfg_so_audit_log one write at a time (each write logs the fields it moved,
   from -> to), and through the snapshot scm.so_revisions keeps of the lines just
   before each approved amendment. Walking back from the present needs no guess
   about where an order started; a write the log cannot place (the line it names is
   not there) marks every step before it unreliable, until an amendment snapshot
   puts the lines back on firm ground.

   WHAT AN EVENT IS, as the live record has it:
     DIRECT     the direct edits of one order on one Malaysia day;
     AMENDMENT  one approved amendment submission (its LINES and PRICE halves
                together, as the live record keys them).
   Only after the order's opening day, and only product lines (no service).

   THE COST each side carries is the cost the order recorded (no re-cost: the
   owner ruled past orders keep theirs). Where the history has none, it is
   estimated from the product's own cost and the event says so:
     - a line that never had a cost stamped (0): its product's cost that day;
     - a line deleted by a write that did not log its cost: its product's cost on
       the order's opening day.
   An event whose cost cannot be told at all, or whose walk lost the thread, is
   left out rather than guessed.

   A price set to RM 0 and later put back (the 2026-10 price-zeroing bug and its
   repair, or any temporary zero) is not a selling change: the drop and the
   put-back are both left out of the selling.

   This is the 2026-11-23 read-only analysis (selling matched scm.so_total_changes
   on 164 / 169 order-days) carried over line for line; the tests pin it on
   made-up orders. */

import { ownCostOn, usualHeights } from './so-line-unit-cost.mjs';

const SIDE = /\s*\((LHF|RHF)\)/g;
const REPAIR = /^line_(.+)_(unit_price_sen|total_sen|line_cost_sen)$/;
const SEAT = /SEAT (\d+)/;
const MYT_MS = 8 * 3600 * 1000;

/* Python's truthiness, so `a or b` reads as the analysis read it. */
const truthy = (v) => !(v == null || v === false || v === 0 || v === ''
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0));
const or = (...vals) => vals.find(truthy) ?? vals[vals.length - 1];

/** Round half to even, as the analysis rounded. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
export const num = (v) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? roundHalfEven(x) : 0;
};

/** Microseconds since the epoch: an ISO timestamp keeps what Postgres gives. */
export function micros(s) {
  if (s instanceof Date) return s.getTime() * 1000;
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d(?::?\d\d)?)?$/.exec(String(s).trim());
  if (!m) throw new Error(`not a timestamp: ${s}`);
  let tz = m[4] ?? 'Z';
  if (/^[+-]\d\d$/.test(tz)) tz += ':00';
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const base = Date.parse(`${m[1]}T${m[2]}${tz}`);
  return base * 1000 + Number(`${(m[3] ?? '').slice(1)}000000`.slice(0, 6));
}
export const mytDay = (us) => new Date(Math.floor(us / 1000) + MYT_MS).toISOString().slice(0, 10);
const isoOf = (us) => new Date(Math.floor(us / 1000)).toISOString();

export const sideFree = (code) => String(code ?? '').replace(SIDE, '').trim();
export const modelOf = (code) => String(code ?? '').split('-')[0].toUpperCase();

/** A line as the walk carries it, from a current line or a snapshot line. */
export function lineOf(r) {
  return {
    id: String(r.id), code: String(or(r.ic, '')).trim(), group: or(r.g, ''),
    qty: num(r.q), unit: num(r.u), disc: num(r.ds), total: num(r.t),
    uc: num(r.uc), lc: num(r.lc), x: r.x === true,
    bk: r.bk ?? null, h: r.h ?? null, fc: r.fc ?? null, est: false, ca: r.ca ?? null,
  };
}

const copyState = (state) => new Map([...state].map(([k, v]) => [k, { ...v }]));

/** The first entry per field of a write's logged fields. */
function byField(fields) {
  const m = new Map();
  for (const f of fields ?? []) {
    if (f && typeof f === 'object' && !Array.isArray(f) && 'field' in f && !m.has(f.field)) m.set(f.field, f);
  }
  return m;
}

/** A line write's fields: the item code it names (label), the code it swapped
 *  from (swap) and the rest by field; 2990's early `…Centi` names read as `…Sen`. */
function parseUpdate(fields) {
  let label = null;
  let swap = null;
  const ch = new Map();
  for (const f of fields ?? []) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    if (f.field === 'itemCode') {
      if (!('from' in f)) { if (label === null) label = String(or(f.to, '')).trim(); }
      else swap = f;
      continue;
    }
    if (!ch.has(f.field)) ch.set(f.field, f);
  }
  for (const [a, b] of [['unitPriceCenti', 'unitPriceSen'], ['totalCenti', 'totalSen'], ['unitCostCenti', 'unitCostSen']]) {
    if (ch.has(a) && !ch.has(b)) ch.set(b, ch.get(a));
  }
  return { label, swap, ch };
}

const sell = (l) => (l == null || l.x ? 0 : l.total);

/**
 * Walk one order back from its current lines. Returns the steps, oldest first,
 * each with the lines just before and just after it.
 *
 * `order`: { d, c, od } (doc no, company, opening day). `linesNow`: its current
 * lines. `audit`: its log rows { id, a, s, at, by, f }. `revsByAmd`: amendment id
 * -> { at, L } (the lines just before that amendment applied). `category(c, code)`:
 * the catalogue category. `estCost(code, qty)`: a deleted line's estimated cost.
 */
export function walkOrder({ order, linesNow, audit, revsByAmd, category, estCost }) {
  const c = order.c;
  const state = new Map();
  for (const r of linesNow) { const l = lineOf(r); state.set(l.id, l); }
  const evs = audit.map((e) => ({ ...e, _t: micros(e.at) }))
    .sort((x, y) => x._t - y._t || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const approvalRev = new Map();
  const subsumed = new Set();
  for (const e of evs) {
    if (e.a !== 'AMENDMENT_SO_APPROVED') continue;
    const amdId = String(or(or(byField(e.f).get('amendment_id'), {}).to, ''));
    const rev = revsByAmd.get(amdId);
    if (!rev) continue;
    approvalRev.set(e.id, [amdId, rev]);
    const rt = micros(rev.at);
    /* The apply's own line writes sit between its snapshot and its approval row. */
    for (const x of evs) {
      if (x.id !== e.id && rt <= x._t && x._t <= e._t && x.a !== 'AMENDMENT_SO_APPROVED' && x.a !== 'CREATE') subsumed.add(x.id);
    }
  }

  const sofaModels = (st) => {
    const out = new Set();
    for (const l of st.values()) {
      if (l.x) continue;
      const g = String(l.group ?? '').toLowerCase();
      if (g === 'sofa' || (!g && category(c, l.code) === 'SOFA')) out.add(String(l.code ?? '').split('-')[0].toUpperCase());
    }
    return out;
  };
  const find = (code, post) => {
    let hits = [...state.values()].filter((l) => l.code === code);
    if (hits.length > 1 && post && Object.keys(post).length > 0) {
      const exact = hits.filter((l) => Object.entries(post).every(([k, v]) => l[k] === v));
      if (exact.length) hits = exact;
    }
    return hits;
  };

  const steps = [];
  const problems = [];
  let broken = null;
  const problem = (e, what) => {
    problems.push([e.at, e.a, what]);
    if (broken === null) broken = e._t;
  };

  for (const e of [...evs].reverse()) {
    if (subsumed.has(e.id)) continue;
    const a = e.a;
    const src = or(e.s, 'web');
    const f = byField(e.f);
    const lineWrite = a === 'UPDATE_LINE' || a === 'ADD_LINE' || a === 'DELETE_LINE';
    const step = {
      at: e._t, day: mytDay(e._t), a, s: src, id: e.id, by: e.by ?? null, diffs: [], reliable: broken === null,
      mAfter: sofaModels(state), stateAfter: lineWrite ? copyState(state) : null,
    };
    if (a === 'CREATE') break;
    if (a === 'AMENDMENT_SO_APPROVED') {
      if (!approvalRev.has(e.id)) { problem(e, 'approval with no snapshot'); continue; }
      const [amdId, rev] = approvalRev.get(e.id);
      const before = new Map();
      for (const r of rev.L ?? []) { const l = lineOf(r); before.set(l.id, l); }
      step.kind = 'amendment';
      step.amd = amdId;
      step.beforeState = copyState(before);
      step.afterState = copyState(state);
      state.clear();
      for (const [k, v] of before) state.set(k, v);
      broken = null;
      steps.push(step);
      continue;
    }
    if (a === 'ADD_LINE') {
      step.kind = 'add';
      if (f.has('deliveryFeeSen') || f.has('deliveryFeeCenti')) continue;
      if (src === 'automation') {
        /* A free gift the automation added: its lines carry RM 0. */
        for (const code of String(or(or(f.get('itemCode'), {}).to, '')).split(',').map((s) => s.trim()).filter(Boolean)) {
          const hits = find(code, { total: 0 });
          if (!hits.length) { problem(e, `free gift ${code}: no such line`); continue; }
          const l = hits[0];
          state.delete(l.id);
          step.diffs.push([null, { ...l }]);
        }
      } else {
        const code = String(or(or(f.get('itemCode'), {}).to, '')).trim();
        const want = num(or(f.get('totalSen'), f.get('totalCenti'), {}).to);
        const hits = find(code, { total: want });
        if (!hits.length) { problem(e, `add ${code}: no such line`); continue; }
        const pick = hits[0];
        /* A sofa build adds its pieces in one write, under one build key. */
        const build = truthy(pick.bk) && String(pick.bk).startsWith('build-add-')
          ? [...state.values()].filter((l) => l.bk === pick.bk) : [pick];
        for (const l of build) { state.delete(l.id); step.diffs.push([null, { ...l }]); }
      }
    } else if (a === 'DELETE_LINE') {
      step.kind = 'delete';
      if (f.has('deliveryFeeSen') || f.has('deliveryFeeCenti')) continue;
      if (src === 'automation') {
        for (const code of String(or(or(f.get('itemCode'), {}).from, '')).split(',').map((s) => s.trim()).filter(Boolean)) {
          const ec = estCost(code, 1);
          const l = { id: `del:${e.id}:${code}:${state.size}`, code, group: '', qty: 1, unit: 0, disc: 0, total: 0, uc: ec, lc: ec, x: false, bk: null, h: null, fc: null, est: true, ca: null };
          state.set(l.id, l);
          step.diffs.push([{ ...l }, null]);
        }
      } else {
        const qty = num(or(f.get('qty'), {}).from);
        const unit = num(or(f.get('unitPriceSen'), f.get('unitPriceCenti'), {}).from);
        const total = num(or(f.get('totalSen'), f.get('totalCenti'), {}).from);
        const dcode = String(or(or(f.get('itemCode'), {}).from, '')).trim();
        const ec = estCost(dcode, qty);
        const l = {
          id: `del:${e.id}`, code: dcode, group: '', qty, unit, disc: qty * unit - total, total,
          uc: Math.floor(ec / Math.max(1, qty)), lc: ec, x: false, bk: null, h: null, fc: null, est: true, ca: null,
        };
        state.set(l.id, l);
        step.diffs.push([{ ...l }, null]);
      }
    } else if (a === 'UPDATE_LINE') {
      step.kind = 'edit';
      if (f.has('deliveryFeeSen') || f.has('deliveryFeeCenti')) continue;
      const rep = (e.f ?? []).filter((x) => x && typeof x === 'object' && !Array.isArray(x) && REPAIR.test(String(x.field)));
      if (rep.length) {
        /* A repair script's write: line_<code>_<field> from -> to. */
        step.kind = 'repair';
        const byCode = new Map();
        for (const x of rep) {
          const m = REPAIR.exec(x.field);
          if (!byCode.has(m[1])) byCode.set(m[1], {});
          byCode.get(m[1])[m[2]] = x;
        }
        for (const [code, r] of byCode) {
          const post = {};
          if ('unit_price_sen' in r) post.unit = num(r.unit_price_sen.to);
          if ('line_cost_sen' in r) post.lc = num(r.line_cost_sen.to);
          const hits = find(code, post);
          if (!hits.length) { problem(e, `repair ${code}: no such line`); continue; }
          const l = hits[0];
          const b = { ...l };
          if ('unit_price_sen' in r) b.unit = num(r.unit_price_sen.from);
          if ('total_sen' in r) b.total = num(r.total_sen.from);
          else if ('unit_price_sen' in r) b.total = b.qty * b.unit - b.disc;
          if ('line_cost_sen' in r) { b.lc = num(r.line_cost_sen.from); b.uc = Math.floor(b.lc / Math.max(1, b.qty)); }
          step.diffs.push([b, { ...l }]);
          state.set(l.id, b);
        }
      } else {
        const { label, swap, ch } = parseUpdate(e.f);
        const money = ['qty', 'unitPriceSen', 'discountSen', 'cancelled', 'itemGroup', 'unitCostSen', 'spec'].filter((k) => ch.has(k));
        if (!money.length && !swap) continue;
        const postCode = swap ? String(or(swap.to, '')).trim() : label;
        const post = {};
        if (ch.has('qty')) post.qty = num(ch.get('qty').to);
        if (ch.has('unitPriceSen')) post.unit = num(ch.get('unitPriceSen').to);
        if (ch.has('discountSen')) post.disc = num(ch.get('discountSen').to);
        if (ch.has('unitCostSen')) post.uc = num(ch.get('unitCostSen').to);
        const hits = truthy(postCode)
          ? find(postCode, post)
          : [...state.values()].filter((l) => Object.entries(post).every(([k, v]) => l[k] === v));
        if (!hits.length) { problem(e, `edit ${postCode}: no such line`); continue; }
        const l = hits[0];
        const off = Object.entries(post).filter(([k, v]) => l[k] !== v);
        if (off.length) {
          /* The line moved again since: trust the logged selling; keep the cost the
             line carries (a set-price spread or a later fill moved it after). */
          for (const [k, v] of off) { if (k !== 'uc') l[k] = v; }
          l.total = l.qty * l.unit - l.disc;
          if (off.some(([k]) => k === 'qty')) l.lc = l.qty * l.uc;
        }
        const b = { ...l };
        if (ch.has('qty')) b.qty = num(ch.get('qty').from);
        if (ch.has('unitPriceSen')) b.unit = num(ch.get('unitPriceSen').from);
        if (ch.has('discountSen')) b.disc = num(ch.get('discountSen').from);
        if (ch.has('cancelled')) b.x = ch.get('cancelled').from === true;
        if (ch.has('itemGroup')) b.group = String(or(ch.get('itemGroup').from, ''));
        if (swap) b.code = String(or(swap.from, label, '')).trim();
        if (ch.has('spec')) {
          const sf = SEAT.exec(String(or(ch.get('spec').from, '')));
          const st = SEAT.exec(String(or(ch.get('spec').to, '')));
          if (sf && st && sf[1] !== st[1]) { b.h = sf[1]; step.seat = [sf[1], st[1]]; }
        }
        if (['qty', 'unitPriceSen', 'discountSen'].some((k) => ch.has(k))) {
          b.total = l.total + ((b.qty * b.unit - b.disc) - (l.qty * l.unit - l.disc));
        }
        if (ch.has('unitCostSen')) b.uc = num(ch.get('unitCostSen').from);
        if (ch.has('unitCostSen') || ch.has('qty')) b.lc = b.qty * b.uc;
        step.diffs.push([b, { ...l }]);
        state.set(l.id, b);
      }
    } else {
      continue;
    }
    step.mBefore = sofaModels(state);
    step.stateBefore = lineWrite ? copyState(state) : null;
    steps.push(step);
  }
  steps.reverse();
  return { steps, problems };
}

/** The live record's key for an amendment: the first of the submission's halves
 *  (same order, same requester, same reason, created within 5 seconds). */
export function submissionKey(a, amds) {
  if (!a.cr || !a.rb) return String(a.id);
  const at = micros(a.cr);
  const halves = [...amds.values()]
    .filter((x) => x.d === a.d && x.rb === a.rb && (x.reason ?? '') === (a.reason ?? '') && x.cr && Math.abs(micros(x.cr) - at) <= 5_000_000)
    .sort((x, y) => micros(x.cr) - micros(y.cr) || (String(x.id) < String(y.id) ? -1 : 1));
  return String(halves[0]?.id ?? a.id);
}

/** The analysis's product test: no service group, SVC- code, SERVICE category,
 *  or a delivery / disposal / storage / transport / install name. */
export function isNonProduct(categoryOf, code, group) {
  const g = String(or(group, '')).toLowerCase();
  const u = String(or(code, '')).trim().toUpperCase();
  if (g === 'service') return true;
  if (u.startsWith('SVC-') || u.startsWith('SVC ')) return true;
  if (String(or(categoryOf(String(or(code, '')).trim()), '')).toUpperCase() === 'SERVICE') return true;
  return ['MISC', 'TRANSPORTATION CHARGES', 'STORAGE'].includes(u) || u.startsWith('DISPOSE')
    || u.includes('TRANSPORT') || u.includes('DELIVERY') || u.includes('INSTALL');
}

/** A sofa line: its group says so, or with no group its catalogue category. */
export function isSofaLine(categoryOf, code, group) {
  const g = String(or(group, '')).toLowerCase();
  if (g) return g === 'sofa';
  return String(or(categoryOf(String(or(code, '')).trim()), '')).toUpperCase() === 'SOFA';
}

/**
 * The events of one order from its walked steps.
 *
 * `amds`: amendment id -> { id, d, no, cr, rb, reason, L }. `zpi`: Set of
 * `amendmentId|lineId` whose RM 0 price was intended (kept for the record; the
 * analysis's put-back rule does not read it). `category(c, code)`,
 * `ownCost(c, code, day, height)`: unit cost on a day. `foldHalves`: one
 * submission's halves in one event, as the live record keys them.
 */
export function orderEvents({ order, steps, amds, category, ownCost, foldHalves }) {
  const c = order.c;
  const od = order.od;
  const sd = or(order.sd, order.od);
  const categoryOf = (code) => category(c, code);
  const nonProduct = (code, group) => isNonProduct(categoryOf, code, group);
  const isSofa = (code, group) => isSofaLine(categoryOf, code, group);

  /* Pass 1: a price taken to RM 0 and later put back moves no selling. */
  const ignore = new Map();
  const drops = new Map();
  steps.forEach((s, si) => {
    const pairs = [];
    if (s.kind === 'amendment') {
      for (const i of s.beforeState.keys()) {
        if (s.afterState.has(i)) pairs.push([i, s.beforeState.get(i), s.afterState.get(i)]);
      }
    } else if (s.kind === 'edit' || s.kind === 'repair') {
      for (const [b, aa] of s.diffs) if (b && aa) pairs.push([aa.id, b, aa]);
    }
    for (const [i, b, aa] of pairs) {
      if (b.x || aa.x) continue;
      if (b.unit > 0 && aa.unit === 0) {
        const amt = sell(b) - sell(aa);
        if (amt > 0) {
          if (!drops.has(i)) drops.set(i, []);
          drops.get(i).push([si, amt]);
        }
      } else if (b.unit === 0 && aa.unit > 0 && (drops.get(i) ?? []).length) {
        let back = sell(aa) - sell(b);
        for (const d of drops.get(i)) {
          const take = Math.min(back, d[1]);
          if (take <= 0) continue;
          ignore.set(`${d[0]}|${i}`, (ignore.get(`${d[0]}|${i}`) ?? 0) - take);
          ignore.set(`${si}|${i}`, (ignore.get(`${si}|${i}`) ?? 0) + take);
          d[1] -= take;
          back -= take;
        }
        drops.set(i, drops.get(i).filter((d) => d[1] > 0));
      }
    }
  });

  const costedSets = (state) => new Set([...(state ?? new Map()).values()]
    .filter((l) => !l.x && isSofa(l.code, l.group) && (l.lc || 0) > 0).map((l) => modelOf(l.code)));
  /* [cost, how]: recorded | est_zero (stamped 0, the product's cost that day) |
     est_deleted (the walk's estimate for a deleted line) | unknown | none. */
  const costOf = (l, day, sets) => {
    if (l == null || l.x) return [0, 'none'];
    const lc = l.lc || 0;
    if (l.est) return [lc, lc > 0 ? 'est_deleted' : 'unknown'];
    if (lc > 0 || (l.qty || 0) <= 0) return [lc, 'recorded'];
    /* A sofa piece at RM 0 while its set's price sits on another piece. */
    if (isSofa(l.code, l.group) && sets.has(modelOf(l.code))) return [0, 'recorded'];
    const e = ownCost(c, l.code, day, l.h) * l.qty;
    return e > 0 ? [e, 'est_zero'] : [0, 'unknown'];
  };

  const makeEvent = ({ route, day, at, kinds, reliable, pairs, sis, full, extra }) => {
    let rel = reliable;
    const flags = new Set();
    let ds = 0; let dc = 0; let ign = 0;
    let unknown = false; let qtyLines = 0; let qtyNosell = 0;
    const [fullB, fullA] = full;
    const setsB = costedSets(fullB);
    const setsA = costedSets(fullA);
    const lines = [];
    for (const [i, b, a] of pairs) {
      const sb = sell(b); const sa = sell(a);
      const [cb, stb] = costOf(b, sd, setsB);
      const [ca, sta] = costOf(a, day, setsA);
      const ig = sis.reduce((t, x) => t + (ignore.get(`${x}|${i}`) ?? 0), 0);
      if (ig) flags.add('temporary_zero_price_ignored');
      for (const [st, w] of [[stb, 'before'], [sta, 'after']]) {
        if (st === 'est_zero') flags.add(`zero_cost_${w}_estimated`);
        if (st === 'est_deleted') flags.add('removed_line_cost_estimated');
      }
      const moved = (b == null) !== (a == null) || (b != null && a != null && (b.code !== a.code || b.qty !== a.qty || b.x !== a.x));
      if ((moved && (stb === 'unknown' || sta === 'unknown')) || (stb === 'unknown' && ca > 0) || (sta === 'unknown' && cb > 0)) {
        unknown = true;
        flags.add(`cost_unknown_${stb === 'unknown' ? 'before' : 'after'}`);
      }
      /* A deleted line the walk put back was edited again: the walk lost the thread. */
      if (String(i).startsWith('del:') && b != null && a != null) rel = false;
      if (b && a && !b.x && !a.x && b.qty !== a.qty) {
        qtyLines += 1;
        if (sb === sa) qtyNosell += 1;
      }
      ds += (sa - sb) - ig;
      ign += ig;
      dc += ca - cb;
      lines.push({ id: String(i), b: b ?? null, a: a ?? null, sb, sa, cb, ca });
    }
    if (!rel) flags.add('walk_unreliable');
    return {
      doc: order.d, c, route, day, at, kinds, reliable: rel, ds, dc, ignored: ign, judge: !unknown && rel,
      flags: [...flags].sort(), lines, qtyLines, qtyNosell, full, ...extra,
    };
  };

  const events = [];

  /* Amendments: one event per approved amendment, or per submission when folded. */
  const applied = [];
  steps.forEach((s, si) => {
    if (s.kind !== 'amendment') return;
    const a = amds.get(s.amd);
    if (!a || s.day <= od) return;
    applied.push({ s, si, a });
  });
  const groups = [];
  const byKey = new Map();
  for (const x of applied) {
    const k = foldHalves ? submissionKey(x.a, amds) : String(x.a.id);
    if (!byKey.has(k)) { byKey.set(k, []); groups.push(byKey.get(k)); }
    byKey.get(k).push(x);
  }
  for (const group of groups) {
    const firstStep = group[0].s;
    const lastStep = group[group.length - 1].s;
    const bs = firstStep.beforeState;
    const as = lastStep.afterState;
    const modelsIn = (st) => new Set([...st.values()].filter((l) => !l.x && isSofa(l.code, l.group)).map((l) => modelOf(l.code)));
    const kinds = new Map();
    const addKind = (k) => kinds.set(k, (kinds.get(k) ?? 0) + 1);
    const touched = new Set();
    for (const { a } of group) {
      for (const L of a.L ?? []) {
        const ct = L.ct;
        const sid = truthy(L.sid) ? String(L.sid) : null;
        const codeOld = String(or(L.oic, '')).trim();
        const codeNew = String(or(L.nic, '')).trim();
        const grp = or(L.og, '');
        if (ct === 'ADD') {
          if (nonProduct(codeNew, '')) continue;
          addKind(isSofa(codeNew, '') && modelsIn(bs).has(modelOf(codeNew)) ? 'pieces' : 'new_line');
        } else if (ct === 'REMOVE') {
          if (nonProduct(codeOld, grp)) continue;
          if (sid) touched.add(sid);
          addKind(isSofa(codeOld, grp) && modelsIn(as).has(modelOf(codeOld)) ? 'pieces' : 'removed_line');
        } else {
          if (nonProduct(codeOld || codeNew, grp)) continue;
          const ks = [];
          if (codeOld && codeNew && codeOld !== codeNew && sideFree(codeOld) !== sideFree(codeNew)) ks.push('sku');
          if (L.oq != null && L.nq != null && Math.trunc(Number(L.oq)) !== Math.trunc(Number(L.nq))) ks.push('qty');
          const oh = String(or(L.oh, '')).replace(/"/g, '');
          const nh = String(or(L.nh, '')).replace(/"/g, '');
          if (oh && nh && oh !== nh) ks.push('height');
          if (ks.length) {
            if (sid) touched.add(sid);
            for (const k of ks) addKind(k);
          }
        }
      }
    }
    if (!kinds.size) continue;
    const lineAt = (i) => bs.get(i) ?? as.get(i);
    const added = [...as.keys()].filter((i) => !bs.has(i) && !nonProduct(as.get(i).code, as.get(i).group));
    const tset = new Set([...touched, ...added].filter((i) => lineAt(i) && !nonProduct(lineAt(i).code, lineAt(i).group)));
    const tm = new Set([...tset].filter((i) => isSofa(lineAt(i).code, lineAt(i).group)).map((i) => modelOf(lineAt(i).code)));
    const sib = [...new Set([...bs.keys(), ...as.keys()])]
      .filter((i) => isSofa(lineAt(i).code, lineAt(i).group) && tm.has(modelOf(lineAt(i).code)));
    const ids = [...new Set([...tset, ...sib])].sort();
    const pairs = ids.map((i) => [i, bs.get(i) ?? null, as.get(i) ?? null]);
    events.push(makeEvent({
      route: 'amendment', day: firstStep.day, at: lastStep.at, kinds, reliable: true, pairs, sis: group.map((x) => x.si), full: [bs, as],
      extra: {
        amendments: group.map((x) => x.a), approvedBy: [...new Set(group.map((x) => x.s.by).filter(Boolean))],
        windowKey: foldHalves ? submissionKey(group[0].a, amds) : String(group[0].a.id),
      },
    }));
  }

  /* Direct edits: one event per order per Malaysia day. */
  const byDay = new Map();
  steps.forEach((s, si) => {
    if ((s.kind === 'add' || s.kind === 'delete' || s.kind === 'edit') && (s.s === 'web' || s.s === 'automation') && s.day > od) {
      if (!byDay.has(s.day)) byDay.set(s.day, []);
      byDay.get(s.day).push([si, s]);
    }
  });
  for (const [day, ss] of byDay) {
    const kinds = new Map();
    const addKind = (k) => kinds.set(k, (kinds.get(k) ?? 0) + 1);
    const first = new Map();
    const last = new Map();
    const gift = new Map();
    for (const [, s] of ss) {
      if (s.s === 'automation' && (s.kind === 'add' || s.kind === 'delete')) {
        /* The automation's free gifts: their net count of the day is the change. */
        for (const [b, aa] of s.diffs) {
          const l = aa ?? b;
          if (nonProduct(l.code, l.group)) continue;
          const delta = aa ? (truthy(aa.qty) ? aa.qty : 1) : -(truthy(b.qty) ? b.qty : 1);
          gift.set(l.code, (gift.get(l.code) ?? 0) + delta);
        }
        continue;
      }
      for (const [b, aa] of s.diffs) {
        const l = aa ?? b;
        if (nonProduct(l.code, l.group)) continue;
        if (!first.has(l.id)) first.set(l.id, b);
        last.set(l.id, aa);
        if (s.kind === 'add') addKind(isSofa(aa.code, aa.group) && s.mBefore.has(modelOf(aa.code)) ? 'pieces' : 'new_line');
        else if (s.kind === 'delete') addKind(isSofa(b.code, b.group) && s.mAfter.has(modelOf(b.code)) ? 'pieces' : 'removed_line');
        else {
          if (b.code !== aa.code && sideFree(b.code) !== sideFree(aa.code)) addKind('sku');
          if (b.qty !== aa.qty) addKind('qty');
          if (s.seat) addKind('height');
        }
      }
    }
    for (const [, net] of gift) if (net !== 0) addKind(net > 0 ? 'new_line' : 'removed_line');
    if (!kinds.size) continue;
    const pairs = [...first.keys()].map((k) => [k, first.get(k), last.get(k)]);
    for (const [code, net] of gift) {
      if (net === 0) continue;
      const own = ownCost(c, code, day, null);
      const gl = { id: `gift:${code}`, code, group: '', qty: Math.abs(net), unit: 0, disc: 0, total: 0, uc: own, lc: own * Math.abs(net), x: false, bk: null, h: null, fc: null, est: true, ca: null };
      pairs.push(net > 0 ? [`gift:${code}`, null, gl] : [`gift:${code}`, gl, null]);
    }
    events.push(makeEvent({
      route: 'direct', day, at: ss[ss.length - 1][1].at, kinds, reliable: ss.every(([, s]) => s.reliable), pairs,
      sis: ss.map(([si]) => si), full: [ss[0][1].stateBefore ?? new Map(), ss[ss.length - 1][1].stateAfter ?? new Map()],
      extra: { changedBy: [...new Set(ss.map(([, s]) => s.by).filter(Boolean))], windowKey: day },
    }));
  }
  return events;
}

const TYPE_ORDER = ['sku', 'height', 'option', 'pieces', 'qty', 'new_line', 'removed_line'];

/**
 * An event as a row of scm.so_product_changes, or null when it is not one the
 * record keeps: the walk could not tell its cost, it moved neither selling nor
 * cost, or its only change is a quantity that moved no selling (a typo fix).
 * `category(c, code)`; `staffName(id)` for an amendment's requester.
 */
export function recordRow(ev, { category, staffName }) {
  if (!ev.judge) return null;
  const typeSet = new Set(ev.kinds.keys());
  if (typeSet.has('qty') && ev.qtyLines > 0 && ev.qtyNosell === ev.qtyLines) typeSet.delete('qty');
  const types = TYPE_ORDER.filter((t) => typeSet.has(t));
  if (!types.length) return null;
  const bucket = ev.ds !== 0 ? 'SELLING' : ev.dc !== 0 ? 'COST_ONLY' : null;
  if (!bucket) return null;

  const categoryOf = (code) => category(ev.c, code);
  const isSofa = (code, group) => isSofaLine(categoryOf, code, group);
  const [fullB, fullA] = ev.full;
  const modelsIn = (st) => new Set([...st.values()].filter((l) => !l.x && isSofa(l.code, l.group)).map((l) => modelOf(l.code)));
  const modelsB = modelsIn(fullB);
  const modelsA = modelsIn(fullA);
  const side = (l, s, c) => (l == null || l.x ? null : { code: l.code, qty: l.qty, sellingSen: s, costSen: c });
  const lines = ev.lines.map((x) => {
    const t = [];
    const b = x.b && !x.b.x ? x.b : null;
    const a = x.a && !x.a.x ? x.a : null;
    if (!b && a) t.push(isSofa(a.code, a.group) && modelsB.has(modelOf(a.code)) ? 'pieces' : 'new_line');
    else if (b && !a) t.push(isSofa(b.code, b.group) && modelsA.has(modelOf(b.code)) ? 'pieces' : 'removed_line');
    else if (b && a) {
      if (sideFree(b.code) !== sideFree(a.code)) t.push('sku');
      const hb = String(b.h ?? '').replace(/"/g, '').trim();
      const ha = String(a.h ?? '').replace(/"/g, '').trim();
      if (hb && ha && hb !== ha) t.push('height');
      if (b.qty !== a.qty && x.sb !== x.sa) t.push('qty');
    }
    return { id: x.id, types: t, before: side(x.b, x.sb, x.cb), after: side(x.a, x.sa, x.ca) };
  });

  /* The order's product lines before; after = before plus the event's moves, so
     the change the report shows is exactly the change judged. */
  let sellingBefore = 0;
  let costBefore = 0;
  const beforeLines = [];
  for (const l of fullB.values()) {
    if (l.x || isNonProduct(categoryOf, l.code, l.group)) continue;
    sellingBefore += l.total;
    costBefore += l.lc || 0;
    beforeLines.push({
      id: l.id, code: l.code, group: String(l.group ?? '').toLowerCase(), qty: l.qty, sellingSen: l.total, costSen: l.lc || 0,
      spec: l.h ? { seatHeight: l.h } : {},
    });
  }
  beforeLines.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const amendment = ev.route === 'amendment';
  return {
    so_doc_no: ev.doc,
    route: amendment ? 'AMENDMENT' : 'DIRECT',
    window_key: ev.windowKey,
    change_day: ev.day,
    changed_at: isoOf(ev.at),
    changed_by: amendment ? [...new Set(ev.amendments.map((a) => staffName(a.rb)).filter(Boolean))] : ev.changedBy,
    approved_by: amendment ? ev.approvedBy : [],
    amendment_nos: amendment ? ev.amendments.map((a) => a.no).filter(Boolean) : [],
    change_types: types,
    bucket,
    selling_before_sen: sellingBefore,
    selling_after_sen: sellingBefore + ev.ds,
    cost_before_sen: costBefore,
    cost_after_sen: costBefore + ev.dc,
    lines,
    before_lines: beforeLines,
    cost_estimated: ev.flags.some((f) => f.endsWith('_estimated')),
  };
}

/**
 * Every event from `from` (YYYY-MM-DD) as the rows the record keeps, and what was
 * left out. `h` is what the backfill reads: { orders, lines, audit, revisions,
 * amendments } in the walk's shapes, `products` and `history` as the database
 * holds them, `staff` [{ id, name }], and `live` (the windows already recorded).
 */
export function rebuildRecordRows(h, from) {
  const byCo = (rows, f) => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r.c}|${f(r)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const linesBy = byCo(h.lines, (r) => r.d);
  const auditBy = byCo(h.audit, (r) => r.d);
  const revsByAmd = new Map(h.revisions.filter((r) => r.amd).map((r) => [String(r.amd), r]));
  const amds = new Map(h.amendments.map((a) => [String(a.id), { ...a, rb: a.rb ? String(a.rb) : null }]));
  const product = new Map(h.products.map((p) => [`${p.company_id}|${p.code}`, p]));
  const historyOf = new Map();
  for (const r of h.history) {
    const k = `${r.company_id}|${r.item_code}`;
    if (!historyOf.has(k)) historyOf.set(k, []);
    historyOf.get(k).push(r);
  }
  const usual = usualHeights(h.lines.filter((l) => l.h != null).map((l) => ({ item_code: l.ic ?? '', height: l.h, n: 1 })));
  const category = (c, code) => product.get(`${c}|${code}`)?.category ?? null;
  const clean = (x) => String(x).replace(/"/g, '').trim();
  const ownCost = (c, code, day, height) => ownCostOn(product.get(`${c}|${code}`), historyOf.get(`${c}|${code}`) ?? [], day,
    height != null && clean(height) !== '' ? { seatHeight: height } : {}, usual);
  const staffName = (id) => (id ? h.staff.find((s) => s.id === id)?.name?.trim() || null : null);
  const liveKeys = new Set(h.live.map((r) => `${r.company_id}|${r.so_doc_no}|${r.route}|${r.window_key}`));

  const rows = [];
  const left = { notJudged: 0, typoOrNoType: 0, noMove: 0, live: 0, walkProblems: 0 };
  for (const o of h.orders) {
    const { steps, problems } = walkOrder({
      order: o, linesNow: linesBy.get(`${o.c}|${o.d}`) ?? [], audit: auditBy.get(`${o.c}|${o.d}`) ?? [], revsByAmd,
      category, estCost: (code, qty) => ownCost(o.c, code, o.od, null) * Math.max(0, qty),
    });
    left.walkProblems += problems.length;
    for (const ev of orderEvents({ order: o, steps, amds, category, ownCost, foldHalves: true })) {
      if (ev.day < from) continue;
      const row = recordRow(ev, { category, staffName });
      if (!row) {
        if (!ev.judge) left.notJudged += 1;
        else if (ev.ds === 0 && ev.dc === 0) left.noMove += 1;
        else left.typoOrNoType += 1;
        continue;
      }
      const full = { ...row, company_id: o.c, imported: Boolean(o.ac) && String(o.ac).trim().toLowerCase() !== String(o.d).trim().toLowerCase() };
      if (liveKeys.has(`${full.company_id}|${full.so_doc_no}|${full.route}|${full.window_key}`)) { left.live += 1; continue; }
      rows.push(full);
    }
  }
  return { rows, left };
}
