import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/Button';
import { Modal } from '../../../vendor/scm/components/Modal';
import { authedFetch } from '../../../vendor/scm/lib/authed-fetch';

/* Merge Product Models into one kept Model (POST /mfg-products/merge/models/*).
   Check plans and writes nothing; Merge sends back the phrase Check returned, so
   the server refuses if anything changed in between. */

type Plan = {
  refusals: string[];
  pairs: Array<{ drop: string; keep: string; size: string; lines: number; units: number }>;
  moves: Array<{ code: string; size: string }>;
  fills: Array<{ code: string; field: string; from: string }>;
  addSizes: string[];
  foldModels: string[];
  keptOff: boolean;
  leftInactive: number;
  inactiveMoved: number;
  totals: { pairs: number; moves: number; inactive: number; folds: number };
  confirm: string;
};

const mono = { fontFamily: 'var(--font-mono)' };
const input = { ...mono, padding: '6px 8px', fontSize: 'var(--fs-13)', border: '1px solid var(--line-strong, #8a8780)', borderRadius: 6, background: 'var(--c-paper, #fff)' };
const hint = { margin: 0, fontSize: 'var(--fs-12, 12px)', color: 'var(--fg-muted)' };

export const MergeModelsButton = ({ codes }: { codes: string[] }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Merge models</Button>
      {/* On the page body: inside the page header its top sat under the app's tab bar. */}
      {open && createPortal(<MergeModelsDialog codes={codes} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
};

export const MergeModelsDialog = ({ codes, onClose }: { codes: string[]; onClose: () => void }) => {
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
      setPlan(await authedFetch<Plan>('/mfg-products/merge/models/plan', { method: 'POST', body: JSON.stringify({ keep: keep.trim(), drops }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the merge.');
    } finally { setBusy(false); }
  };

  const merge = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await authedFetch<{ merged: string; skuMerges: number; moved: number; folded: number }>('/mfg-products/merge/models/apply', {
        method: 'POST', body: JSON.stringify({ keep: keep.trim(), drops, confirm: plan.confirm }),
      });
      setDone(`Merged into "${r.merged}": ${r.moved} SKU(s) moved, ${r.skuMerges} code(s) merged, ${r.folded} Model(s) switched off.`);
      setPlan(null); setDrops([]);
      void qc.invalidateQueries({ queryKey: ['product-models'] });
      void qc.invalidateQueries({ queryKey: ['mfg-products'] });
    } catch (e) {
      setError(`The merge was not done: ${e instanceof Error ? e.message : 'please try again.'}`);
    } finally { setBusy(false); }
  };

  const work = plan ? plan.totals.pairs + plan.totals.moves + plan.totals.inactive + plan.totals.folds + (plan.keptOff ? 1 : 0) : 0;
  const canMerge = plan !== null && plan.refusals.length === 0 && work > 0;
  return (
    <Modal title="Merge models" onClose={onClose} width="min(760px, 100%)">
      <datalist id="merge-model-codes">{codes.map((c) => <option key={c} value={c} />)}</datalist>
      <label>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Model to keep</div>
        <input list="merge-model-codes" value={keep} placeholder="Type or pick the Model that stays" onChange={(e) => { setKeep(e.target.value); changed(); }} style={{ ...input, width: '100%' }} />
      </label>
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Models to merge into it</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input list="merge-model-codes" value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="Type or pick a Model, then press Add" style={{ ...input, flex: 1 }} aria-label="Add a Model to merge" />
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
        <div style={{ padding: 8, border: '1px solid var(--line)', borderRadius: 4 }}>
          {plan.refusals.map((r) => <div key={r} role="alert" style={{ color: 'var(--c-err, #b3261e)' }}>Cannot merge: {r}</div>)}
          {plan.keptOff && <div>The kept Model is off today and switches on.</div>}
          {plan.moves.map((m) => <div key={m.code} style={mono}>Size {m.size}: {m.code} moves under the kept Model</div>)}
          {plan.pairs.map((p) => <div key={p.drop} style={mono}>Size {p.size}: {p.drop} merges into {p.keep} ({p.lines} document line(s), {p.units} in stock)</div>)}
          {plan.fills.map((f) => <div key={`${f.code}-${f.field}`} style={mono}>{f.code} takes {f.field} from {f.from}</div>)}
          {plan.addSizes.length > 0 && <div>Sizes added to the kept Model: {plan.addSizes.join(', ')}</div>}
          {plan.foldModels.map((m) => <div key={m} style={mono}>{m} switches off</div>)}
          {plan.inactiveMoved > 0 && <div>{plan.inactiveMoved} switched-off SKU(s) move under the kept Model.</div>}
          {plan.leftInactive > 0 && <div style={hint}>{plan.leftInactive} inactive SKU(s) stay as they are.</div>}
          {plan.refusals.length === 0 && work === 0 && <div>Nothing to do: these Models are already merged.</div>}
        </div>
      )}

      {!plan && <p style={hint}>Press Check first. It changes nothing and shows what will move. Then press Merge.</p>}
      {error && <p role="alert" style={{ color: 'var(--c-err, #b3261e)', margin: 0 }}>{error}</p>}
      {done && <p role="status" style={{ margin: 0 }}>{done}</p>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={() => void check()} disabled={busy || !keep.trim() || drops.length === 0}>Check</Button>
        <Button variant="danger" onClick={() => void merge()} disabled={busy || !canMerge}>{busy ? 'Working…' : 'Merge'}</Button>
      </div>
    </Modal>
  );
};
