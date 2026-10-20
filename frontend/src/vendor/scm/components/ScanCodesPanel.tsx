// ----------------------------------------------------------------------------
// ScanCodesPanel — on a finished delivery-order scan card (desktop ScanGrnModal
// and MobileGrnScan): the supplier's own printed codes the scan could not match
// by code ("T1MAMWA0MK"), each with a choice of PO line. Saving remembers the
// code for that supplier, so the next delivery order matches it by code; a scan
// that made no draft yet is matched again and drafted (HC-0120).
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../lib/authed-fetch';
import { writeFailed } from '../lib/mutation-error';

type CodeRow = { printedCode: string; description: string | null; qty: number; status: 'name_matched' | 'not_matched'; suggestedPoItemId: string | null };
type PoLine = { poItemId: string; poNumber: string; itemCode: string; materialName: string | null; remaining: number };
type CodesResp = { data?: { supplierKnown?: boolean; rows?: CodeRow[]; poLines?: PoLine[] } };
type SaveResp = { data?: { saved?: number; draft?: string | null } };

// One choice per item on each PO: picking any of its identical lines teaches the same code.
function itemChoices(lines: PoLine[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, { value: string; label: string; owed: number }>();
  for (const l of lines) {
    const key = `${l.poNumber}|${l.itemCode}`;
    const prev = seen.get(key);
    if (prev) { prev.owed += l.remaining; prev.label = `${l.itemCode} (${l.poNumber}, owes ${prev.owed})`; continue; }
    seen.set(key, { value: l.poItemId, owed: l.remaining, label: `${l.itemCode} (${l.poNumber}, owes ${l.remaining})` });
  }
  return [...seen.values()].map(({ value, label }) => ({ value, label }));
}

export function ScanCodesPanel({ jobId, jobsQueryKey }: { jobId: string; jobsQueryKey: readonly unknown[] }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['scan-gr-codes', jobId],
    queryFn: () => authedFetch<CodesResp>(`/scan-gr/jobs/${jobId}/codes`),
    retry: false,
  });
  const rows = data?.data?.rows ?? [];
  const lines = data?.data?.poLines ?? [];
  const lineById = new Map(lines.map((l) => [l.poItemId, l]));
  // A suggested line is the first of its item; map it onto the choice for that item.
  const choiceFor = (poItemId: string | null): string => {
    const l = poItemId ? lineById.get(poItemId) : undefined;
    if (!l) return '';
    return itemChoices(lines).find((c) => { const cl = lineById.get(c.value); return cl?.poNumber === l.poNumber && cl.itemCode === l.itemCode; })?.value ?? '';
  };
  const [picked, setPicked] = useState<Record<string, string>>({});
  const valueOf = (r: CodeRow): string => picked[r.printedCode] ?? choiceFor(r.suggestedPoItemId);
  const [result, setResult] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (pairs: Array<{ printedCode: string; poItemId: string }>) =>
      authedFetch<SaveResp>(`/scan-gr/jobs/${jobId}/codes`, { method: 'POST', body: JSON.stringify({ pairs }), headers: { 'Content-Type': 'application/json' } }),
    onSuccess: (r) => {
      const n = r.data?.saved ?? 0;
      const draft = r.data?.draft ?? null;
      setResult(`${n} ${n === 1 ? 'code' : 'codes'} saved for this supplier. ${draft ? `Draft goods receipt ${draft} was created from this delivery order.` : 'The next delivery order with these codes will match them.'}`);
      void qc.invalidateQueries({ queryKey: jobsQueryKey });
    },
    onError: writeFailed,
  });

  const box: React.CSSProperties = { marginTop: 8, padding: 10, borderRadius: 10, border: '1px solid var(--line, #e3e1d9)', background: 'var(--surface, #fff)', fontSize: 12.5 };
  if (result) return <div style={box}>{result}</div>;
  if (isLoading) return <div style={box}>Loading the codes on this delivery order...</div>;
  if (error) return <div style={box}>{error instanceof Error ? error.message : 'Could not load the codes.'}</div>;
  if (data?.data?.supplierKnown === false) return <div style={box}>We could not tell which supplier this delivery order is from, so its codes cannot be saved.</div>;
  if (rows.length === 0) return <div style={box}>Every item on this delivery order already matches by code.</div>;

  const choices = itemChoices(lines);
  const pairs = rows.map((r) => ({ printedCode: r.printedCode, poItemId: valueOf(r) })).filter((p) => p.poItemId !== '');
  return (
    <div style={box}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Supplier codes</div>
      <div style={{ color: 'var(--fg-muted, #767b6e)', marginBottom: 8 }}>
        Choose which item each code on the delivery order is. Leave a code on "Not on the PO" for free gifts. Saved codes match automatically next time.
      </div>
      {rows.map((r) => (
        <div key={r.printedCode} style={{ padding: '6px 0', borderTop: '1px solid var(--line, #eeece5)' }}>
          <div>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{r.printedCode}</span> x{r.qty}
            {r.status === 'name_matched' && <span style={{ marginLeft: 6, fontWeight: 600, fontSize: 11, color: '#16695f' }}>matched by name</span>}
          </div>
          {r.description && <div style={{ color: 'var(--fg-muted, #767b6e)', margin: '2px 0 4px' }}>{r.description}</div>}
          <select
            aria-label={`Item for ${r.printedCode}`}
            value={valueOf(r)}
            onChange={(e) => setPicked((cur) => ({ ...cur, [r.printedCode]: e.target.value }))}
            style={{ width: '100%', minHeight: 36, borderRadius: 8, border: '1px solid var(--line, #d6d3c8)', padding: '0 8px', font: 'inherit', background: '#fff' }}
          >
            <option value="">Not on the PO</option>
            {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
      ))}
      <button
        type="button"
        disabled={pairs.length === 0 || save.isPending}
        onClick={() => save.mutate(pairs)}
        style={{ marginTop: 8, minHeight: 36, padding: '0 14px', borderRadius: 8, border: 'none', background: pairs.length === 0 ? '#c9c6bb' : '#16695f', color: '#fff', font: 'inherit', fontWeight: 700, cursor: pairs.length === 0 ? 'default' : 'pointer' }}
      >
        {save.isPending ? 'Saving...' : `Save ${pairs.length} ${pairs.length === 1 ? 'code' : 'codes'}`}
      </button>
    </div>
  );
}
