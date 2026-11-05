import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/Button';
import { Modal } from '../../../vendor/scm/components/Modal';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';

/* Merge duplicate SKU codes into one kept code (POST /mfg-products/merge/*).
   Check plans and writes nothing; Merge sends back the phrase Check returned,
   so the server refuses if anything changed in between. AutoCount is merged by
   hand in AutoCount - this dialog lists which AutoCount item each code sends to. */

type Plan = {
  pairs: Array<{
    drop: string; keep: string; refusals: string[];
    rekey: Array<{ table: string; rows: number }>;
    unitsMoved: number; retire: boolean;
    dropStock: Array<{ warehouse: string; qty: number }>;
  }>;
  keepStock: Array<{ warehouse: string; qty: number }>;
  totals: { pairs: number; refused: number; rowsToRekey: number; unitsMoved: number; toRetire: number };
  confirm: string;
  autoCount: Array<{ code: string; acItemCode: string | null; detail: string | null }>;
};

const stockText = (s: Array<{ warehouse: string; qty: number }>) => s.map((x) => `${x.warehouse} ${x.qty}`).join(', ') || 'none';
const mono = { fontFamily: 'var(--font-mono)' };
const input = { ...mono, padding: '6px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--line-strong, #8a8780)', borderRadius: 6, background: 'var(--c-paper, #fff)' };
const hint = { margin: 0, fontSize: 'var(--fs-12, 12px)', color: 'var(--fg-muted)' };

export const MergeCodesDialog = ({ codes, onClose }: { codes: string[]; onClose: () => void }) => {
  const qc = useQueryClient();
  const [keep, setKeep] = useState('');
  const [draft, setDraft] = useState('');
  const [drops, setDrops] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const changed = () => { setPlan(null); setDone(null); setError(null); };
  const add = () => {
    const code = draft.trim();
    if (!code) return;
    if (code === keep.trim() || drops.includes(code)) { setError(`"${code}" is already in the list.`); return; }
    setDrops([...drops, code]);
    setDraft('');
    changed();
  };

  const check = async () => {
    setBusy(true); changed();
    try {
      setPlan(await authedFetch<Plan>('/mfg-products/merge/plan', { method: 'POST', body: JSON.stringify({ keep: keep.trim(), drops }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the merge.');
    } finally { setBusy(false); }
  };

  const merge = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await authedFetch<{ merged: string[]; rekeyed: number }>('/mfg-products/merge/apply', {
        method: 'POST', body: JSON.stringify({ keep: keep.trim(), drops, confirm: plan.confirm }),
      });
      setDone(`Merged ${r.merged.length} code(s) into "${keep.trim()}", ${r.rekeyed} line(s) moved. Stock allocation is being recomputed.`);
      setPlan(null); setDrops([]);
      void qc.invalidateQueries({ queryKey: ['mfg-products'] });
    } catch (e) {
      setError(`The merge was not done: ${e instanceof Error ? e.message : 'please try again.'}`);
    } finally { setBusy(false); }
  };

  const canMerge = plan && plan.totals.refused === 0 && plan.totals.pairs > 0;
  const summary = !keep.trim() ? 'Step 1: choose the code to keep.'
    : drops.length === 0 ? `Keeping ${keep.trim()}. Step 2: add at least one code to merge into it.`
      : `Keeping ${keep.trim()}, merging ${drops.length} code(s) into it. ${plan ? (canMerge ? 'Check passed.' : 'Check found a problem.') : 'Not checked yet.'}`;
  return (
    <Modal title="Merge product codes" onClose={onClose} width="min(760px, 100%)">
      <datalist id="merge-sku-codes">{codes.map((c) => <option key={c} value={c} />)}</datalist>
      <label>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Code to keep</div>
        <input list="merge-sku-codes" value={keep} placeholder="Type or pick the code that stays" onChange={(e) => { setKeep(e.target.value); changed(); }} style={{ ...input, width: '100%', boxSizing: 'border-box' }} />
      </label>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Codes to merge into it (add one by one)</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input list="merge-sku-codes" value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Type or pick a code to merge in, then press Add" style={{ ...input, flex: 1 }} aria-label="Add a code to merge" />
          <Button variant="secondary" onClick={add}>Add</Button>
        </div>
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {drops.map((d) => (
            <li key={d} style={mono}>
              {d}{' '}
              <button type="button" onClick={() => { setDrops(drops.filter((x) => x !== d)); changed(); }}>Remove</button>
            </li>
          ))}
        </ul>
      </div>

      {plan && (
        <div>
          <p style={{ margin: 0 }}>Stock on "{plan.pairs[0]?.keep}" now: {stockText(plan.keepStock)}. Each stock batch keeps its own cost; nothing is re-costed.</p>
          {plan.pairs.map((p) => (
            <div key={p.drop} style={{ marginTop: 8, padding: 8, border: '1px solid var(--line)', borderRadius: 4 }}>
              <div style={mono}>{p.drop} → {p.keep}</div>
              {p.refusals.length > 0
                ? p.refusals.map((r) => <div key={r} role="alert" style={{ color: 'var(--c-err, #b3261e)' }}>Refused: {r}</div>)
                : (
                  <div>
                    Moves {p.rekey.reduce((s, r) => s + r.rows, 0)} line(s) ({p.rekey.map((r) => `${r.table} ${r.rows}`).join(', ') || 'none'});
                    {' '}stock {stockText(p.dropStock)}{p.retire ? '; then switched off.' : '.'}
                  </div>
                )}
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600 }}>AutoCount: merge these by hand in AutoCount (Change Item Code, "Perform Merge")</div>
            {plan.autoCount.map((a) => (
              <div key={a.code} style={mono}>{a.code}: {a.acItemCode ?? `no single AutoCount item (${a.detail ?? ''})`}</div>
            ))}
          </div>
        </div>
      )}

      <p style={{ margin: 0, fontWeight: 600 }} role="status">{summary}</p>
      {plan && !canMerge && <p style={hint}>Merge is off: {plan.totals.pairs === 0 ? 'there is nothing to merge.' : 'some codes are refused above. Fix or remove them, then press Check again.'}</p>}
      {!plan && <p style={hint}>Press Check first. Merge turns on only after a Check that has no refused codes. Changing any code asks for a new Check.</p>}
      {error && <p role="alert" style={{ color: 'var(--c-err, #b3261e)', margin: 0 }}>{error}</p>}
      {done && <p role="status" style={{ margin: 0 }}>{done}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={() => void check()} disabled={busy || !keep.trim() || drops.length === 0}>Check</Button>
        <Button variant="danger" onClick={() => void merge()} disabled={busy || !canMerge}>
          {busy ? 'Working…' : `Merge ${plan ? plan.totals.pairs - plan.totals.refused : 0} code(s)`}
        </Button>
      </div>
    </Modal>
  );
};
