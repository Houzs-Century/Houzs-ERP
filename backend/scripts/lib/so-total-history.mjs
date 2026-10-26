/* An order's goods and total over time, rebuilt from its modification history.

   WHY (owner 2026-10-26, Event Commission: 「10月的我也要算」 /「本身不是有
   history吗？」). scm.so_total_changes records every change of an order's goods
   and total only from 2026-10-20 09:10 UTC. The upsales and drop sales of
   1–19 October exist only in the SO modification history, so they are rebuilt
   from it and written into that table, tagged 'history' (or 'history-ignored'
   for the price-zeroing bug and its put-backs, which do not count).

   HOW. The order's lines as they stand NOW are known exactly. Walk its history
   BACKWARDS, undoing one recorded event at a time, and the lines before every
   event fall out:
     - ADD_LINE      the line was not there before: remove it (a split sofa
                     build logs one row for all its module lines: remove the
                     whole build, the lines sharing its variants.buildKey);
     - DELETE_LINE   the line was there: put it back (code, qty, unit, total);
     - UPDATE_LINE   restore each "from" value on the line; the row names the
                     line by its code BEFORE the edit (a swap carries from/to),
                     never by id, and carries only the fields that moved — the
                     factor that did not move is read off the line itself, which
                     the walk already holds as it was right after the edit;
     - an approved amendment writes no line rows, but scm.so_revisions holds the
                     whole order as it stood right before the apply: the walk
                     takes that snapshot as the "before" outright (and anything
                     logged between the snapshot and the approval belongs to the
                     apply). A snapshot also heals the walk: whatever was wrong
                     below a broken step is exact again from the snapshot down.
   Line total = qty × unit − discount, as the line PATCH writes it.

   CHECKS (the plan prints them per order):
     - at CREATE: the rebuilt total equals the CREATE row's localTotalSen;
     - at the end of the window: the rebuilt goods equal the goods the recorder
       saw first (its first row's before figure, else the header now).
   A step the walk cannot undo (no line with that code, no snapshot for an
   approval) marks the order BROKEN from there down to the next snapshot.

   WHAT DOES NOT COUNT (the 2026-10-13 rules, owner agreed 「可以」):
     - the price-zeroing bug (BUG-63): a line's price X→0 in a save that also
       swapped its code or changed its spec, or an approved SPEC amendment that
       carried a price of 0 for a line that had one;
     - its put-back: the same line (by id, else code) 0→X after such a zeroing,
       and every row of the repair script;
   Opening-day edits and the first price of an unpriced order are left to the
   report, which decides them from the row's date and before-total. */

const MONEY_UPDATE_FIELDS = ['qty', 'unitPriceSen', 'discountSen', 'cancelled', 'itemGroup'];
const SPEC_FIELDS = /^(spec|customSpecials|description|description2|variants\..*)$/;
const REPAIR_FIELD = /^line_(.+)_(unit_price_sen|total_sen)$/;

const num = (v) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

export function isServiceLine(l) {
  const g = String(l.group ?? '').toUpperCase();
  const c = String(l.code ?? '').trim().toUpperCase();
  return g.includes('SERVICE') || (c.length > 4 && c.startsWith('SVC-'));
}

/** A line row (DB row or snapshot line, snake_case) in the walk's shape. */
export function lineOf(r) {
  const variants = r.variants && typeof r.variants === 'object' ? r.variants : null;
  return {
    id: String(r.id),
    code: String(r.item_code ?? '').trim(),
    group: String(r.item_group ?? ''),
    qty: num(r.qty),
    unit: num(r.unit_price_sen),
    discount: num(r.discount_sen),
    total: num(r.total_sen),
    cancelled: r.cancelled === true,
    buildKey: r.build_key ?? variants?.buildKey ?? null,
  };
}

/** Goods (the four goods buckets: every live non-service line) and total (every
 *  live line, plus the header delivery fee on a legacy order with no fee lines). */
export function totalsOf(lines, headerFeeSen = 0) {
  let goods = 0;
  let total = 0;
  let feeLines = false;
  for (const l of lines.values()) {
    if (l.code.toUpperCase().startsWith('SVC-DELIVERY')) feeLines = true;
    if (l.cancelled) continue;
    total += l.total;
    if (!isServiceLine(l)) goods += l.total;
  }
  if (!feeLines) total += num(headerFeeSen);
  return { goods, total };
}

/** UPDATE_LINE field_changes: the label (the code before the edit — no "from"
 *  key), a code swap (has "from"), and every other field by name. */
export function parseUpdate(fields) {
  let label = null;
  let swap = null;
  const ch = {};
  for (const f of fields ?? []) {
    if (!f || typeof f !== 'object') continue;
    if (f.field === 'itemCode') {
      if (!has(f, 'from')) { if (label === null) label = String(f.to ?? '').trim(); } else swap = f;
      continue;
    }
    ch[f.field] = f;
  }
  return { label, swap, ch };
}

function fieldsByName(fields) {
  const m = {};
  for (const f of fields ?? []) if (f && typeof f === 'object' && !(f.field in m)) m[f.field] = f;
  return m;
}

const fTotal = (l) => (l.qty * l.unit) - l.discount;
const cloneState = (state) => new Map([...state].map(([k, l]) => [k, { ...l }]));
const sameMoney = (a, b) => a.qty === b.qty && a.unit === b.unit && a.discount === b.discount && a.total === b.total && a.cancelled === b.cancelled;

function lineDiff(before, after) {
  const l = after ?? before;
  return {
    lineId: (before ?? after).id,
    code: l.code,
    beforeUnit: before ? before.unit : 0,
    afterUnit: after ? after.unit : 0,
    beforeTotal: before && !before.cancelled ? before.total : 0,
    afterTotal: after && !after.cancelled ? after.total : 0,
    isGoods: !isServiceLine(l),
  };
}

/** Every line that moved between two line sets: by id, then by code. */
export function diffLineSets(beforeSet, afterSet) {
  const b = [...beforeSet.values()];
  const a = [...afterSet.values()];
  const aById = new Map(a.map((l) => [l.id, l]));
  const used = new Set();
  const pairs = [];
  for (const lb of b) {
    const la = aById.get(lb.id);
    if (la) { used.add(la.id); pairs.push([lb, la]); } else pairs.push([lb, null]);
  }
  for (const p of pairs) {
    if (p[1]) continue;
    const la = a.find((x) => !used.has(x.id) && x.code === p[0].code);
    if (la) { used.add(la.id); p[1] = la; }
  }
  for (const la of a) if (!used.has(la.id)) pairs.push([null, la]);
  return pairs
    .filter(([lb, la]) => !lb || !la || !sameMoney(lb, la))
    .map(([lb, la]) => lineDiff(lb, la));
}

/**
 * Walk one order's history backwards.
 *
 * @param o.lines      the order's line rows now (all, cancelled included)
 * @param o.events     audit rows since the floor, any order: { id, at (ms),
 *                     action, source, actor, fields }
 * @param o.revisions  so_revisions rows: { at (ms), amendmentId, lines }
 * @param o.headerFeeSen  header delivery_fee_sen (legacy orders without fee lines)
 * @returns { steps (oldest first), create, problems, brokenSpans }
 *   step: { at, kind, action, source, actor, eventId, before, after, diffs,
 *           zeroed: [lineIds/codes], reliable }
 */
export function walkOrder(o) {
  const state = new Map(o.lines.map((r) => { const l = lineOf(r); return [l.id, l]; }));
  const fee = num(o.headerFeeSen);
  const events = [...o.events].sort((x, y) => x.at - y.at || String(x.id).localeCompare(String(y.id)));
  const revByAmendment = new Map();
  for (const r of o.revisions ?? []) if (r.amendmentId) revByAmendment.set(String(r.amendmentId), r);

  // An approval and the snapshot its apply took: everything logged in between is the apply's own.
  const subsumed = new Set();
  const approvalRev = new Map();
  for (const e of events) {
    if (e.action !== 'AMENDMENT_SO_APPROVED') continue;
    const amendmentId = String(fieldsByName(e.fields).amendment_id?.to ?? '');
    const rev = revByAmendment.get(amendmentId);
    if (!rev) continue;
    approvalRev.set(e.id, rev);
    for (const x of events) {
      if (x.id !== e.id && x.at >= rev.at && x.at <= e.at && x.action !== 'AMENDMENT_SO_APPROVED' && x.action !== 'CREATE') subsumed.add(x.id);
    }
  }

  const steps = [];
  const problems = [];
  let broken = null; // the time the walk lost the thread, until the next snapshot heals it
  let create = null;

  const problem = (e, what) => {
    problems.push({ at: e.at, eventId: e.id, action: e.action, what });
    if (broken === null) broken = e.at;
  };
  const findByCode = (code, post) => {
    let c = [...state.values()].filter((l) => l.code === code);
    if (c.length > 1 && post) {
      const exact = c.filter((l) => Object.entries(post).every(([k, v]) => l[k] === v));
      if (exact.length > 0) c = exact;
    }
    return c;
  };

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (subsumed.has(e.id)) continue;
    const after = totalsOf(state, fee);
    const step = { at: e.at, action: e.action, source: e.source ?? 'web', actor: e.actor ?? null, eventId: e.id, after, diffs: [], zeroed: [], reliable: broken === null };
    const f = fieldsByName(e.fields);

    if (e.action === 'CREATE') {
      const want = num(f.localTotalSen?.to);
      const all = totalsOf(state, fee).total;
      let noSvc = 0;
      for (const l of state.values()) if (!l.cancelled && !isServiceLine(l)) noSvc += l.total;
      create = { at: e.at, want, got: all, gotGoods: noSvc, ok: all === want || noSvc === want, reliable: broken === null, lines: state.size, wantLines: num(f.lineCount?.to) };
      state.clear();
      broken = null;
      break;
    }

    if (e.action === 'AMENDMENT_SO_APPROVED') {
      const rev = approvalRev.get(e.id);
      if (!rev) { problem(e, 'approval with no snapshot'); continue; }
      const before = new Map((rev.lines ?? []).map((r) => { const l = lineOf(r); return [l.id, l]; }));
      step.kind = 'amendment';
      step.amendmentId = String(f.amendment_id?.to ?? '');
      step.diffs = diffLineSets(before, state);
      state.clear();
      for (const [k, l] of before) state.set(k, l);
      broken = null; // the snapshot is exact
      step.before = totalsOf(state, fee);
      steps.push(step);
      continue;
    }

    if (e.action === 'ADD_LINE') {
      step.kind = 'add';
      if (f.deliveryFeeSen) {
        undoFee(state, f.deliveryFeeSen);
      } else if ((e.source ?? 'web') === 'automation') {
        for (const code of String(f.itemCode?.to ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
          const c = findByCode(code, { total: 0 });
          if (c.length === 0) { problem(e, `free gift ${code}: no such line`); continue; }
          state.delete(c[0].id);
          step.diffs.push(lineDiff(null, c[0]));
        }
      } else {
        const code = String(f.itemCode?.to ?? '').trim();
        const wantTotal = num(f.totalSen?.to);
        const c = findByCode(code, { total: wantTotal });
        if (c.length === 0) { problem(e, `add ${code}: no such line`); continue; }
        const pick = c[0];
        const build = pick.buildKey && String(pick.buildKey).startsWith('build-add-')
          ? [...state.values()].filter((l) => l.buildKey === pick.buildKey) : [pick];
        const got = build.reduce((s, l) => s + (l.cancelled ? 0 : l.total), 0);
        if (got !== wantTotal) problem(e, `add ${code}: lines total ${got}, the row says ${wantTotal}`);
        for (const l of build) { state.delete(l.id); step.diffs.push(lineDiff(null, l)); }
      }
    } else if (e.action === 'DELETE_LINE') {
      step.kind = 'delete';
      if (f.deliveryFeeSen) {
        undoFee(state, f.deliveryFeeSen);
      } else if ((e.source ?? 'web') === 'automation') {
        for (const code of String(f.itemCode?.from ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
          const l = { id: `del:${e.id}:${code}`, code, group: '', qty: 1, unit: 0, discount: 0, total: 0, cancelled: false, buildKey: null };
          state.set(l.id, l);
          step.diffs.push(lineDiff(l, null));
        }
      } else {
        const qty = num(f.qty?.from);
        const unit = num(f.unitPriceSen?.from);
        const total = num(f.totalSen?.from);
        const l = { id: `del:${e.id}`, code: String(f.itemCode?.from ?? '').trim(), group: '', qty, unit, discount: (qty * unit) - total, total, cancelled: false, buildKey: null };
        state.set(l.id, l);
        step.diffs.push(lineDiff(l, null));
      }
    } else if (e.action === 'UPDATE_LINE') {
      step.kind = 'edit';
      if (f.deliveryFeeSen) {
        undoFee(state, f.deliveryFeeSen);
      } else {
        const repair = (e.fields ?? []).filter((x) => x && REPAIR_FIELD.test(String(x.field)));
        if (repair.length > 0) {
          step.repair = true;
          const byCode = new Map();
          for (const x of repair) {
            const [, code, col] = String(x.field).match(REPAIR_FIELD);
            const r = byCode.get(code) ?? {};
            r[col] = x;
            byCode.set(code, r);
          }
          for (const [code, r] of byCode) {
            const post = {};
            if (r.unit_price_sen) post.unit = num(r.unit_price_sen.to);
            const c = findByCode(code, post);
            if (c.length === 0) { problem(e, `repair ${code}: no such line`); continue; }
            const l = c[0];
            const before = { ...l };
            if (r.unit_price_sen) before.unit = num(r.unit_price_sen.from);
            before.total = r.total_sen ? num(r.total_sen.from) : l.total + (fTotal(before) - fTotal(l));
            step.diffs.push(lineDiff(before, l));
            state.set(l.id, before);
          }
        } else {
          const { label, swap, ch } = parseUpdate(e.fields);
          const moves = MONEY_UPDATE_FIELDS.filter((k) => ch[k]);
          if (moves.length === 0 && !swap) continue; // a date, a photo, a remark: no money, no code
          {
            const postCode = swap ? String(swap.to ?? '').trim() : label;
            const post = {};
            if (ch.qty) post.qty = num(ch.qty.to);
            if (ch.unitPriceSen) post.unit = num(ch.unitPriceSen.to);
            if (ch.discountSen) post.discount = num(ch.discountSen.to);
            if (ch.cancelled) post.cancelled = ch.cancelled.to === true;
            let c = postCode ? findByCode(postCode, post) : [];
            if (!postCode) {
              // the price-override side door logs the price alone, with no label
              c = [...state.values()].filter((l) => Object.entries(post).every(([k, v]) => l[k] === v));
            }
            if (c.length === 0) { problem(e, `edit ${postCode ?? '(no label)'}: no such line`); continue; }
            const distinct = new Set(c.map((l) => `${l.qty}|${l.unit}|${l.discount}|${l.total}|${l.cancelled}`));
            if (distinct.size > 1) problem(e, `edit ${postCode ?? '(no label)'}: ${c.length} lines could be it`);
            const off = Object.entries(post).filter(([k, v]) => c[0][k] !== v);
            if (off.length > 0) problem(e, `edit ${postCode ?? '(no label)'}: the line reads ${off.map(([k]) => `${k} ${c[0][k]}`).join(', ')}, the row says ${off.map(([k, v]) => `${k} ${v}`).join(', ')}`);
            const l = c[0];
            if (off.length > 0) {
              // Undo the row on the values it names, not on a line that disagrees with it.
              for (const [k, v] of off) l[k] = v;
              l.total = fTotal(l);
              step.after = totalsOf(state, fee);
            }
            const before = { ...l };
            if (ch.qty) before.qty = num(ch.qty.from);
            if (ch.unitPriceSen) before.unit = num(ch.unitPriceSen.from);
            if (ch.discountSen) before.discount = num(ch.discountSen.from);
            if (ch.cancelled) before.cancelled = ch.cancelled.from === true;
            if (ch.itemGroup) before.group = String(ch.itemGroup.from ?? '');
            if (swap) before.code = String(swap.from ?? label ?? '').trim();
            if (ch.qty || ch.unitPriceSen || ch.discountSen) before.total = l.total + (fTotal(before) - fTotal(l));
            const d = lineDiff(before, l);
            const specMoved = !!swap || Object.keys(ch).some((k) => SPEC_FIELDS.test(k));
            if (specMoved && before.unit > 0 && l.unit === 0) step.zeroed.push(l.id, l.code);
            if (d.beforeTotal !== d.afterTotal || d.beforeUnit !== d.afterUnit) step.diffs.push(d);
            state.set(l.id, before);
          }
        }
      }
    } else {
      continue;
    }
    step.before = totalsOf(state, fee);
    steps.push(step);
  }

  steps.reverse();
  return { steps, create, problems, nowTotals: totalsOf(new Map(o.lines.map((r) => { const l = lineOf(r); return [l.id, l]; })), fee) };

  function undoFee(st, fx) {
    for (const [k, l] of [...st]) if (l.code.toUpperCase().startsWith('SVC-DELIVERY')) st.delete(k);
    const from = num(fx.from);
    if (from > 0) st.set(`fee:${fx.from}`, { id: `fee:${fx.from}`, code: 'SVC-DELIVERY', group: 'service', qty: 1, unit: from, discount: 0, total: from, cancelled: false, buildKey: null });
  }
}

/** The goods state at a moment: the "after" of the last step at or before it,
 *  else the "before" of the first step after it. */
export function totalsAt(steps, at, nowTotals) {
  let last = null;
  for (const s of steps) { if (s.at < at) last = s; else return last ? last.after : s.before; }
  return last ? last.after : nowTotals;
}

/**
 * Which line moves do not count: the zeroing bug and its put-backs.
 * `amendZero` = Set of SO line ids an applied SPEC amendment carried at price 0
 * while the line had a price (so_amendment_lines).
 * Marks diff.ignored = 'zeroed' | 'put_back' in place.
 */
export function classify(steps, amendZero = new Set()) {
  const pending = new Set();
  for (const s of steps) {
    for (const d of s.diffs) {
      if (!d.isGoods) continue;
      const zeroedHere = d.beforeUnit > 0 && d.afterUnit === 0 && (
        (s.kind === 'edit' && (s.zeroed.includes(d.lineId) || s.zeroed.includes(d.code)))
        || (s.kind === 'amendment' && amendZero.has(d.lineId)));
      if (zeroedHere) {
        d.ignored = 'zeroed';
        pending.add(d.lineId); pending.add(d.code);
      } else if (s.repair) {
        d.ignored = 'put_back';
        pending.delete(d.lineId); pending.delete(d.code);
      } else if (d.beforeUnit === 0 && d.afterUnit > 0 && (pending.has(d.lineId) || pending.has(d.code))) {
        d.ignored = 'put_back';
        pending.delete(d.lineId); pending.delete(d.code);
      }
    }
  }
  return steps;
}

/**
 * The rows to write for the steps in [from, to): one save = the steps of one
 * person within 10 seconds of each other (an amendment is always its own save).
 * Per save: a 'history-ignored' row for the moves that do not count, then a
 * 'history' row for the rest — only when goods moved.
 */
export function rowsFor(steps, from, to, { HISTORY = 'history', HISTORY_IGNORED = 'history-ignored', GAP_MS = 10_000 } = {}) {
  const inWin = steps.filter((s) => s.at >= from && s.at < to && (s.after.goods !== s.before.goods || s.after.total !== s.before.total));
  const saves = [];
  for (const s of inWin) {
    const prev = saves.at(-1)?.at(-1);
    const joins = prev && s.kind !== 'amendment' && prev.kind !== 'amendment' && (prev.actor ?? '') === (s.actor ?? '') && s.at - prev.at <= GAP_MS;
    if (joins) saves.at(-1).push(s); else saves.push([s]);
  }
  const rows = [];
  for (const save of saves) {
    const first = save[0];
    const last = save.at(-1);
    const ignored = save.flatMap((s) => s.diffs).filter((d) => d.isGoods && d.ignored).reduce((sum, d) => sum + (d.afterTotal - d.beforeTotal), 0);
    const goodsMoved = last.after.goods - first.before.goods;
    const counted = goodsMoved - ignored;
    const base = { at: last.at, actor: last.actor ?? first.actor ?? null, kind: save.some((s) => s.kind === 'amendment') ? 'amendment' : 'edit', reliable: save.every((s) => s.reliable), steps: save.length };
    if (ignored !== 0) {
      rows.push({ ...base, source: HISTORY_IGNORED, beforeGoods: first.before.goods, afterGoods: first.before.goods + ignored, beforeTotal: first.before.total, afterTotal: first.before.total + ignored, why: [...new Set(save.flatMap((s) => s.diffs).filter((d) => d.ignored).map((d) => d.ignored))].join('+') });
    }
    if (counted !== 0) {
      rows.push({ ...base, source: HISTORY, beforeGoods: first.before.goods + ignored, afterGoods: last.after.goods, beforeTotal: first.before.total + ignored, afterTotal: last.after.total });
    }
  }
  return rows;
}
