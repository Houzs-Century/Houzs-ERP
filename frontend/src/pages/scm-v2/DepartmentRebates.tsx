// ----------------------------------------------------------------------------
// DepartmentRebates — the selling department's supplier rebates on the Department P&L
// (owner 2026-11-27: his supplier's terms estimated in the Exhibition's Performance
// P&L; 「做设定框」 — Finance types them once, here, and they stay in the settings,
// never in the code). The rules are the server's (backend/src/scm/lib/
// supplier-rebates.ts); here percentages are in %, amounts in RM.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useSaveSupplierRebates, type SupplierRebateRule } from '../../vendor/scm/lib/department-queries';
import s from './Logistics.module.css';

/** One rule as the form holds it — every field as typed. */
export type RebateDraft = {
  supplierCode: string; label: string; sponsorPct: string; namedWords: string; accessoryWords: string;
  tiers: Array<{ fromRm: string; pct: string }>; displayPct: string;
};

const pctOf = (bp: number): string => String(bp / 100);
const rmOf = (sen: number): string => String(sen / 100);

/** A blank rule, one empty tier row to fill. */
export const blankDraft = (): RebateDraft => ({
  supplierCode: '', label: '', sponsorPct: '', namedWords: '', accessoryWords: '', tiers: [{ fromRm: '', pct: '' }], displayPct: '',
});

/** A saved rule as the form shows it. */
export const toDraft = (r: SupplierRebateRule): RebateDraft => ({
  supplierCode: r.supplierCode, label: r.label, sponsorPct: r.sponsorBp > 0 ? pctOf(r.sponsorBp) : '',
  namedWords: r.namedWords.join(', '), accessoryWords: r.accessoryWords.join(', '),
  tiers: r.salesTiers.length > 0 ? r.salesTiers.map((t) => ({ fromRm: rmOf(t.fromSen), pct: pctOf(t.bp) })) : [{ fromRm: '', pct: '' }],
  displayPct: r.displayDiscountBp > 0 ? pctOf(r.displayDiscountBp) : '',
});

const wordsOf = (v: string): string[] => [...new Set(v.split(',').map((w) => w.trim().toUpperCase()).filter(Boolean))];
const bpOf = (v: string): number | null => {
  const t = v.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 && Math.round(n * 100) === n * 100 ? Math.round(n * 100) : null;
};
const senOf = (v: string): number | null => {
  const t = v.trim().replace(/,/g, '');
  const n = Number(t);
  return t !== '' && Number.isFinite(n) && n >= 0 && Math.round(n * 100) === n * 100 ? Math.round(n * 100) : null;
};

/** True when nothing of the rule is typed — the form leaves it out. */
export const isBlankDraft = (d: RebateDraft): boolean =>
  [d.supplierCode, d.label, d.sponsorPct, d.namedWords, d.accessoryWords, d.displayPct].every((v) => v.trim() === '')
  && d.tiers.every((t) => t.fromRm.trim() === '' && t.pct.trim() === '');

/** A rule as the server takes it, or what to fix first. An empty tier row is left out. */
export function fromDraft(d: RebateDraft): { ok: true; rule: SupplierRebateRule } | { ok: false; message: string } {
  const code = d.supplierCode.trim().toUpperCase();
  if (!code) return { ok: false, message: 'Give each supplier’s code.' };
  const sponsorBp = bpOf(d.sponsorPct);
  if (sponsorBp == null) return { ok: false, message: `${code}: the sponsor rebate is a percentage from 0 to 100, two decimals at most.` };
  const displayDiscountBp = bpOf(d.displayPct);
  if (displayDiscountBp == null) return { ok: false, message: `${code}: the display discount is a percentage from 0 to 100, two decimals at most.` };
  const salesTiers: SupplierRebateRule['salesTiers'] = [];
  for (const t of d.tiers) {
    if (t.fromRm.trim() === '' && t.pct.trim() === '') continue;
    const fromSen = senOf(t.fromRm);
    const bp = bpOf(t.pct);
    if (fromSen == null || bp == null || bp === 0) return { ok: false, message: `${code}: each sales rebate tier needs the amount it starts from and a rate above 0.` };
    salesTiers.push({ fromSen, bp });
  }
  return {
    ok: true,
    rule: {
      supplierCode: code, label: d.label.trim() || code, sponsorBp,
      namedWords: wordsOf(d.namedWords), accessoryWords: wordsOf(d.accessoryWords), salesTiers, displayDiscountBp,
    },
  };
}

const rm = (sen: number): string => `RM ${(sen / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** One rule in a line: who, the sponsor rate and what it leaves out, the tiers, the display discount. */
export function ruleSummary(r: SupplierRebateRule): string {
  const parts = [`${r.label} (${r.supplierCode})`];
  if (r.sponsorBp > 0) parts.push(`sponsor ${pctOf(r.sponsorBp)}%${r.namedWords.length > 0 ? ` less ${r.namedWords.join(', ')} and accessories` : ' less accessories'}`);
  if (r.salesTiers.length > 0) parts.push(`sales ${r.salesTiers.map((t) => `${pctOf(t.bp)}% from ${rm(t.fromSen)}`).join(', ')} less display sets`);
  if (r.displayDiscountBp > 0) parts.push(`display discount ${pctOf(r.displayDiscountBp)}%`);
  return parts.join(' · ');
}

const field: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12, marginTop: 6 };
const strong: React.CSSProperties = { fontWeight: 600, color: 'var(--fin-ink)' };

function RulesEditor({ rules, onClose }: { rules: readonly SupplierRebateRule[]; onClose: () => void }) {
  const save = useSaveSupplierRebates();
  const [drafts, setDrafts] = useState<RebateDraft[]>(() => (rules.length > 0 ? rules.map(toDraft) : [blankDraft()]));
  const [problem, setProblem] = useState<string | null>(null);
  const patch = (i: number, over: Partial<RebateDraft>) => setDrafts((ds) => ds.map((d, k) => (k === i ? { ...d, ...over } : d)));
  const patchTier = (i: number, j: number, over: Partial<RebateDraft['tiers'][number]>) =>
    setDrafts((ds) => ds.map((d, k) => (k === i ? { ...d, tiers: d.tiers.map((t, m) => (m === j ? { ...t, ...over } : t)) } : d)));
  const onSave = () => {
    const out: SupplierRebateRule[] = [];
    for (const d of drafts) {
      if (isBlankDraft(d)) continue;
      const r = fromDraft(d);
      if (!r.ok) { setProblem(r.message); return; }
      out.push(r.rule);
    }
    setProblem(null);
    save.mutate(out, { onSuccess: onClose });
  };
  return (
    <div role="group" aria-label="Supplier rebate rules" style={{ width: '100%' }}>
      {drafts.map((d, i) => {
        const n = i + 1;
        return (
          <fieldset key={n} style={{ border: '1px solid var(--line, #d9d5cd)', borderRadius: 8, padding: '6px 10px', margin: '8px 0' }}>
            <legend style={strong}>Supplier {n}</legend>
            <label style={field}>Supplier code
              <input className={s.input} aria-label={`Supplier ${n} code`} value={d.supplierCode} onChange={(e) => patch(i, { supplierCode: e.target.value })} style={{ width: 110, textAlign: 'left' }} />
            </label>
            <label style={field}>Name shown
              <input className={s.input} aria-label={`Supplier ${n} name shown`} value={d.label} onChange={(e) => patch(i, { label: e.target.value })} style={{ width: 160, textAlign: 'left' }} />
            </label>
            <label style={field}>Sponsor rebate %
              <input className={s.input} type="number" min={0} max={100} step={0.01} aria-label={`Supplier ${n} sponsor rebate %`} value={d.sponsorPct} onChange={(e) => patch(i, { sponsorPct: e.target.value })} style={{ width: 70 }} />
            </label>
            <label style={field}>Products left out (words of their names, comma-separated)
              <input className={s.input} aria-label={`Supplier ${n} products left out`} value={d.namedWords} onChange={(e) => patch(i, { namedWords: e.target.value })} style={{ width: 240, textAlign: 'left' }} />
            </label>
            <label style={field}>Accessories on bills with no product (words, comma-separated)
              <input className={s.input} aria-label={`Supplier ${n} accessory words`} value={d.accessoryWords} onChange={(e) => patch(i, { accessoryWords: e.target.value })} style={{ width: 240, textAlign: 'left' }} />
            </label>
            <div style={{ marginTop: 6 }}>
              <div className={s.muted}>Sales rebate tiers — the month&rsquo;s purchases less display sets reaching:</div>
              {d.tiers.map((t, j) => (
                <span key={j} style={field}>
                  from RM
                  <input className={s.input} aria-label={`Supplier ${n} tier ${j + 1} from RM`} value={t.fromRm} onChange={(e) => patchTier(i, j, { fromRm: e.target.value })} style={{ width: 100 }} />
                  rate %
                  <input className={s.input} type="number" min={0} max={100} step={0.01} aria-label={`Supplier ${n} tier ${j + 1} rate %`} value={t.pct} onChange={(e) => patchTier(i, j, { pct: e.target.value })} style={{ width: 70 }} />
                  {d.tiers.length > 1 && (
                    <button type="button" className={s.btn} onClick={() => patch(i, { tiers: d.tiers.filter((_, m) => m !== j) })} aria-label={`Remove supplier ${n} tier ${j + 1}`}>Remove</button>
                  )}
                </span>
              ))}
              <button type="button" className={s.btn} onClick={() => patch(i, { tiers: [...d.tiers, { fromRm: '', pct: '' }] })}>Add tier</button>
            </div>
            <label style={field}>Display discount %
              <input className={s.input} type="number" min={0} max={100} step={0.01} aria-label={`Supplier ${n} display discount %`} value={d.displayPct} onChange={(e) => patch(i, { displayPct: e.target.value })} style={{ width: 70 }} />
            </label>
            <button type="button" className={s.btn} onClick={() => setDrafts((ds) => (ds.length > 1 ? ds.filter((_, k) => k !== i) : [blankDraft()]))}>Remove supplier</button>
          </fieldset>
        );
      })}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className={s.btn} onClick={() => setDrafts((ds) => [...ds, blankDraft()])}>Add supplier</button>
        <button type="button" className={`${s.btn} ${s.btnSolid}`} disabled={save.isPending} onClick={onSave}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button type="button" className={s.btn} disabled={save.isPending} onClick={onClose}>Cancel</button>
        {problem && <span role="alert" className={s.problem}>{problem}</span>}
      </div>
    </div>
  );
}

/** The selling department's supplier rebates in Performance: what is set, and the form to set it. */
export function SupplierRebatesBox({ rules }: { rules: readonly SupplierRebateRule[] }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className={s.rates} aria-label="Supplier rebates">
      <span className={s.rate}>
        <span>
          <span style={strong}>Supplier rebates</span> — estimated under other income from the month&rsquo;s bills from the supplier:{' '}
          {rules.length === 0 ? 'none set.' : rules.map(ruleSummary).join('; ')}
        </span>
      </span>
      {!editing && <button type="button" className={s.btn} onClick={() => setEditing(true)}>{rules.length === 0 ? 'Set up' : 'Edit'}</button>}
      {editing && <RulesEditor rules={rules} onClose={() => setEditing(false)} />}
    </div>
  );
}
