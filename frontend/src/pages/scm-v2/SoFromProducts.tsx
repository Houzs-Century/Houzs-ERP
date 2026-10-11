// ----------------------------------------------------------------------------
// SoFromProducts — Generate Sales Orders from the product catalog (Commander
// 2026-05-29: "Generate SO from product … 做成这种UI", mirroring the
// Create-GRN-from-PO / PurchaseOrder-from-SO batch pages).
//
// Two ways to bulk-create SOs, both loop the normal POST /mfg-sales-orders so
// every server rule (sofa-exclusive, single mattress brand, processing+delivery
// paired, dates ≥ today, pricing recompute, audit) is enforced per order:
//
//   1. Quick test batch — generates N realistic orders across the three real
//      buying combos with staggered processing days (Commander's business
//      nature): Mattress only / Mattress + Bedframe / Sofa set (+ accessory).
//      Bedframes prefer CODY (the Hookka-priced model). Sofa sets carry a
//      colour-matched module composition (variants.cells) so the MRP Sofa tab
//      shows them as a set.
//
//   2. Pick products — a GRN-from-PO-style grid: tick products + set qty, set a
//      shared customer + dates, and each ticked line becomes its own SO.
//
// Runs in the signed-in browser, so no service key / SQL needed.
// Route: /scm/sales-orders/generate
//
// HOUZS VENDOR: react-router → react-router-dom; queries/components/shared all
// repointed to the vendored layer; navigation → /scm/sales-orders.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Sparkles, CheckSquare, Square, PlayCircle } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { fmtDateOrDash } from '../../vendor/shared/format';
import { useMfgProducts, type MfgProductRow } from '../../vendor/scm/lib/mfg-products-queries';
import { useCreateMfgSalesOrder } from '../../vendor/scm/lib/sales-order-queries';
import { DataGrid, type DataGridColumn } from '../../vendor/scm/components/DataGrid';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { DateField } from "../../vendor/scm/components/DateField";

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/* DataGrid layout key for the product picker. The legacy list rendered one
   sticky section per category — seed a default "group by Category" layout
   ONCE (first visit only) to keep that read; afterwards the operator's own
   layout persists. */
const PICK_GRID_KEY = 'dg-so-from-products-pick';
if (typeof window !== 'undefined' && window.localStorage.getItem(PICK_GRID_KEY) == null) {
  try {
    window.localStorage.setItem(PICK_GRID_KEY, JSON.stringify({ groupBy: ['category'] }));
  } catch { /* storage full / disabled — grid just starts flat */ }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
const todayMY = (): string => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const pick = <T,>(arr: T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length]!;

const CUSTOMERS = [
  'Teoh Ghee Hock', 'Vijaya Lakshmi', 'Syafiq bin Rahman', 'Ong Hui Fang', 'Daniel Tan Jia Hao',
  'Priya a/p Ramasamy', 'Chong Kah Wai', 'Nurul Aisyah binti Razak', 'Heng Yong Sheng', 'Lim Mei Ling',
  'Arjun Nair', 'Siti Khadijah', 'Wong Zhi Hao', 'Farah Iskandar', 'Goh Beng Choo',
  'Rajesh Kumar', 'Tan Wei Jie', 'Nor Aziah binti Yusof', 'Lee Chin Hwa', 'Muthu Samy',
];
const COLOURS = ['Mocha', 'Charcoal', 'Beige', 'Grey', 'Navy', 'Cream', 'Latte'];
const FABRICS = ['BF-16', 'BF-22', 'PC151-01', 'FB-09', 'LN-31'];
const DIVANS = ['10', '13', '15'];
const LEGS = ['NO LEG', '2', '4'];
const SEATS = ['24', '28', '30'];
/* Representative colour-matched module compositions (a "set"). */
const SOFA_SETS: string[][] = [
  ['2A', 'L', '2A'], ['1A', 'L', '1A'], ['2A', '2A'], ['1S', 'CNR', '2S'],
  ['2A', 'L', '1A'], ['2S', 'STOOL'], ['1S', '2S'], ['2A', 'CNR', '2A'],
];

type GenLine = {
  itemCode: string;
  itemGroup: 'mattress' | 'bedframe' | 'sofa' | 'accessory';
  description: string;
  qty: number;
  variants: Record<string, unknown> | null;
  /* Sent to the server as the line price. The server recomputes and rejects
     the whole SO if the client value drifts >0.5%, so for priced products we
     echo their own price (test products are unpriced → 0 is safe). */
  unitPriceCenti?: number;
};
type SoSpec = {
  customerName: string;
  combo: 'Mattress only' | 'Mattress + Bedframe' | 'Sofa set';
  processingDate: string;
  deliveryDate: string;
  lines: GenLine[];
};

/* ── test-batch generator ───────────────────────────────────────────────── */
function buildTestBatch(
  prods: { mattress: MfgProductRow[]; bedframe: MfgProductRow[]; sofa: MfgProductRow[]; accessory: MfgProductRow[] },
  counts: { mattressOnly: number; mattressBedframe: number; sofaSet: number },
  baseDate: string,
): SoSpec[] {
  const specs: SoSpec[] = [];
  // CODY first (Commander: bedframes from the Hookka-priced CODY model), else any bedframe.
  const cody = prods.bedframe.filter((p) => p.code.toUpperCase().startsWith('CODY'));
  const bedframes = cody.length > 0 ? cody : prods.bedframe;
  let cust = 0;

  // 1. Mattress only — shortest processing (ready soonest).
  for (let i = 0; i < counts.mattressOnly; i++) {
    const m = pick(prods.mattress, i);
    if (!m) break;
    const proc = addDays(baseDate, 3 + (i % 8));      // ~3–10 days out
    specs.push({
      customerName: pick(CUSTOMERS, cust++), combo: 'Mattress only',
      processingDate: proc, deliveryDate: addDays(proc, 5),
      lines: [{ itemCode: m.code, itemGroup: 'mattress', description: m.name, qty: 1 + (i % 2), variants: null }],
    });
  }

  // 2. Mattress + Bedframe — medium processing (bedframe must be ordered).
  for (let i = 0; i < counts.mattressBedframe; i++) {
    const bf = pick(bedframes, i);
    const m = pick(prods.mattress, i + 3);
    if (!bf || !m) break;
    const proc = addDays(baseDate, 14 + (i % 10));     // ~2–3.5 weeks out
    specs.push({
      customerName: pick(CUSTOMERS, cust++), combo: 'Mattress + Bedframe',
      processingDate: proc, deliveryDate: addDays(proc, 7),
      lines: [
        { itemCode: m.code, itemGroup: 'mattress', description: m.name, qty: 1, variants: null },
        {
          itemCode: bf.code, itemGroup: 'bedframe', description: bf.name, qty: 1,
          variants: {
            fabricCode: pick(FABRICS, i), colorCode: pick(COLOURS, i),
            divanHeight: pick(DIVANS, i), legHeight: pick(LEGS, i + 1), gap: '0', totalHeight: '17',
          },
        },
      ],
    });
  }

  // 3. Sofa set (+ accessory) — longest processing (made-to-order set).
  for (let i = 0; i < counts.sofaSet; i++) {
    const sofa = pick(prods.sofa, i);
    if (!sofa) break;
    const modules = pick(SOFA_SETS, i);
    const proc = addDays(baseDate, 28 + (i % 14));     // ~4–6 weeks out
    const lines: GenLine[] = [{
      itemCode: sofa.code, itemGroup: 'sofa', description: sofa.name, qty: 1,
      variants: {
        cells: modules.map((moduleId) => ({ moduleId })),
        fabricCode: pick(FABRICS, i + 2), colorCode: pick(COLOURS, i + 2),
        depth: pick(SEATS, i), seatHeight: pick(SEATS, i), legHeight: pick(LEGS, i), tier: 'PRICE_2',
      },
    }];
    // Most sofa sets ride with a pillow accessory.
    const acc = prods.accessory.length > 0 ? pick(prods.accessory, i) : null;
    if (acc && i % 2 === 0) lines.push({ itemCode: acc.code, itemGroup: 'accessory', description: acc.name, qty: 2, variants: null });
    specs.push({
      customerName: pick(CUSTOMERS, cust++), combo: 'Sofa set',
      processingDate: proc, deliveryDate: addDays(proc, 10), lines,
    });
  }

  return specs;
}

const specToBody = (s: SoSpec) => ({
  debtorName: s.customerName,
  processingDate: s.processingDate,
  customerDeliveryDate: s.deliveryDate,
  items: s.lines.map((l) => ({
    itemCode: l.itemCode,
    itemGroup: l.itemGroup,
    description: l.description,
    qty: l.qty,
    unitPriceCenti: l.unitPriceCenti ?? 0,
    variants: l.variants,
  })),
});

/* ── page ───────────────────────────────────────────────────────────────── */
export const SoFromProducts = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  const prodQ = useMfgProducts({});
  const createSo = useCreateMfgSalesOrder();

  const products = useMemo(() => prodQ.data ?? [], [prodQ.data]);
  const byCat = useMemo(() => ({
    mattress: products.filter((p) => p.category === 'MATTRESS'),
    bedframe: products.filter((p) => p.category === 'BEDFRAME'),
    sofa: products.filter((p) => p.category === 'SOFA'),
    accessory: products.filter((p) => p.category === 'ACCESSORY'),
  }), [products]);

  // Quick test batch config.
  const [counts, setCounts] = useState({ mattressOnly: 35, mattressBedframe: 10, sofaSet: 5 });
  const [baseDate, setBaseDate] = useState<string>(todayMY());

  // Manual picker.
  const [manualCustomer, setManualCustomer] = useState('');
  const [manualProc, setManualProc] = useState<string>('');
  const [manualDeliv, setManualDeliv] = useState<string>('');
  const [picks, setPicks] = useState<Record<string, { picked: boolean; qty: number }>>({});

  // Run state.
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ created: string[]; errors: { name: string; msg: string }[] } | null>(null);

  const preview = useMemo(
    () => (products.length ? buildTestBatch(byCat, counts, baseDate) : []),
    [products.length, byCat, counts, baseDate],
  );

  const runBatch = async (specs: SoSpec[]) => {
    if (specs.length === 0) return;
    setRunning(true); setResult(null); setProgress({ done: 0, total: specs.length });
    const created: string[] = [];
    const errors: { name: string; msg: string }[] = [];
    for (const s of specs) {
      try {
        const res = await createSo.mutateAsync(specToBody(s));
        created.push(res.docNo);
      } catch (e) {
        errors.push({ name: s.customerName, msg: e instanceof Error ? e.message : 'Something went wrong.' });
      }
      setProgress((p) => ({ done: p.done + 1, total: p.total }));
    }
    setRunning(false);
    setResult({ created, errors });
  };

  // Manual: each ticked product → its own one-line SO (always composition-valid).
  const pickedManual = Object.entries(picks).filter(([, v]) => v.picked && v.qty > 0);
  const runManual = () => {
    if (!manualCustomer.trim()) { notify({ title: 'Enter a customer name first.', tone: 'error' }); return; }
    if (Boolean(manualProc) !== Boolean(manualDeliv)) { notify({ title: 'Processing Date and Delivery Date must be set together (or both empty).', tone: 'error' }); return; }
    // Loo 2026-06-11 — mirror the SO API's date gates (no past dates; factory
    // start never after delivery) so a bad manual pick fails HERE, not as a
    // per-SO 400 row in the batch result. The input `min` attr alone is
    // bypassable (typed dates / a page left open across midnight).
    if (manualProc && manualProc < todayMY()) { notify({ title: 'Processing Date cannot be in the past — pick today or a future date.', tone: 'error' }); return; }
    if (manualDeliv && manualDeliv < todayMY()) { notify({ title: 'Delivery Date cannot be in the past — pick today or a future date.', tone: 'error' }); return; }
    if (manualProc && manualDeliv && manualProc > manualDeliv) { notify({ title: 'Processing Date cannot be later than the Delivery Date.', tone: 'error' }); return; }
    const specs: SoSpec[] = pickedManual.map(([code, v]) => {
      const p = products.find((x) => x.code === code)!;
      const group = (p.category.toLowerCase() as GenLine['itemGroup']);
      return {
        customerName: manualCustomer.trim(), combo: 'Mattress only',
        processingDate: manualProc, deliveryDate: manualDeliv,
        lines: [{ itemCode: p.code, itemGroup: group, description: p.name, qty: v.qty, variants: null, unitPriceCenti: p.price1_sen ?? 0 }],
      };
    });
    void runBatch(specs);
  };

  const togglePick = (code: string) =>
    setPicks((s) => ({ ...s, [code]: s[code]?.picked ? { picked: false, qty: 0 } : { picked: true, qty: s[code]?.qty || 1 } }));
  const setQty = (code: string, qty: number) => setPicks((s) => ({ ...s, [code]: { picked: true, qty } }));
  const clearPicks = () => setPicks({});

  /* Picker grid columns (owner request 2026-06-12). Checkbox + qty are
     CONTROLLED off `picks`, so windowed rendering on long catalogs can't
     drop in-progress state; both cells stop propagation so a click never
     double-fires through the row. */
  const pickColumns = useMemo<DataGridColumn<MfgProductRow>[]>(() => {
    const stop = {
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    };
    return [
      {
        key: 'pick',
        label: '',
        width: 36,
        minWidth: 36,
        sortable: false,
        groupable: false,
        accessor: (p) => (
          <span {...stop} style={{ display: 'inline-flex' }}>
            <input
              type="checkbox"
              aria-label={`Pick ${p.code}`}
              checked={Boolean(picks[p.code]?.picked)}
              onChange={() => togglePick(p.code)}
              style={{ cursor: 'pointer' }}
            />
          </span>
        ),
        searchValue: () => '',
      },
      {
        key: 'category',
        label: 'Category',
        width: 110,
        accessor: (p) => p.category,
        filterValue: (p) => p.category,
        groupValue: (p) => p.category,
      },
      {
        key: 'code',
        label: 'Code',
        width: 170,
        accessor: (p) => (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}>{p.code}</span>
        ),
        searchValue: (p) => p.code,
        filterValue: (p) => p.code,
        sortFn: (a, b) => (a.code ?? '').localeCompare(b.code ?? ''),
      },
      {
        key: 'name',
        label: 'Name',
        width: 280,
        accessor: (p) => p.name,
        filterValue: (p) => p.name,
        sortFn: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
      },
      {
        key: 'qty',
        label: 'Qty',
        width: 80,
        align: 'right',
        sortable: false,
        groupable: false,
        accessor: (p) => {
          const on = Boolean(picks[p.code]?.picked);
          return (
            <span {...stop} style={{ display: 'inline-flex' }}>
              <input
                type="number"
                min={1}
                value={on ? picks[p.code]!.qty : ''}
                placeholder="1"
                disabled={!on}
                onChange={(e) => setQty(p.code, Math.max(1, Number(e.target.value) || 1))}
                className={styles.fieldInput}
                style={{ textAlign: 'right', padding: '3px 6px', fontSize: 'var(--fs-12)', width: 64 }}
              />
            </span>
          );
        },
        searchValue: () => '',
      },
    ];
  }, [picks]);

  const totalTest = counts.mattressOnly + counts.mattressBedframe + counts.sofaSet;

  return (
    <div className="space-y-4">
      <PageHeader back
        eyebrow="Supply Chain"
        title="Generate SO from Products"
        actions={
          <div className={styles.actions}>
            <Button variant="ghost" size="md" onClick={() => navigate('/scm/sales-orders')}>
              <X {...ICON} /> Done
            </Button>
          </div>
        }
      />

      {/* Progress / result banner */}
      {(running || result) && (
        <section className={styles.card}>
          <div className={styles.cardBody}>
            {running ? (
              <p style={{ margin: 0, fontWeight: 600 }}>
                Generating… {progress.done} / {progress.total}
              </p>
            ) : result ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  Created {result.created.length} SO{result.created.length === 1 ? '' : 's'}
                  {result.errors.length > 0 ? ` · ${result.errors.length} failed` : ''}.
                </p>
                {result.created.length > 0 && (
                  <p style={{ margin: 0, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                    {result.created.slice(0, 12).join(', ')}{result.created.length > 12 ? ` … +${result.created.length - 12} more` : ''}
                  </p>
                )}
                {result.errors.length > 0 && (
                  <details>
                    <summary style={{ cursor: 'pointer', color: 'var(--c-orange)', fontSize: 'var(--fs-12)' }}>
                      {result.errors.length} failed — show why
                    </summary>
                    <ul style={{ margin: '6px 0 0', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                      {result.errors.slice(0, 10).map((e, i) => <li key={i}>{e.name}: {e.msg}</li>)}
                    </ul>
                  </details>
                )}
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button variant="primary" size="sm" onClick={() => navigate('/scm/sales-orders')}>Open Sales Orders</Button>
                  <Button variant="ghost" size="sm" onClick={() => setResult(null)}>Dismiss</Button>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      )}

      {/* Card 1 — Quick test batch */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}><Sparkles {...ICON} /> Quick test batch</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Realistic orders across the three buying combos, with staggered processing days.
          </span>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Mattress only</span>
              <input type="number" min={0} max={200} value={counts.mattressOnly}
                onChange={(e) => setCounts((c) => ({ ...c, mattressOnly: Math.max(0, Number(e.target.value) || 0) }))}
                className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Mattress + Bedframe (CODY)</span>
              <input type="number" min={0} max={200} value={counts.mattressBedframe}
                onChange={(e) => setCounts((c) => ({ ...c, mattressBedframe: Math.max(0, Number(e.target.value) || 0) }))}
                className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Sofa set (+ accessory)</span>
              <input type="number" min={0} max={200} value={counts.sofaSet}
                onChange={(e) => setCounts((c) => ({ ...c, sofaSet: Math.max(0, Number(e.target.value) || 0) }))}
                className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Base date (processing window starts here)</span>
              <DateField fullWidth value={baseDate} min={todayMY()} onChange={(iso) => setBaseDate(iso)} className={styles.fieldInput}/>
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            <Button variant="primary" size="md" disabled={running || prodQ.isLoading || preview.length === 0}
              onClick={() => void runBatch(preview)}>
              <PlayCircle {...ICON} />
              {running ? 'Generating…' : `Generate ${preview.length} test SO${preview.length === 1 ? '' : 's'}`}
            </Button>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {prodQ.isLoading ? 'Loading products…'
                : prodQ.isError ? "We couldn't load the product catalog — please refresh and try again."
                : products.length === 0 ? 'No products in catalog.'
                : `Target ${totalTest} · mattress ${byCat.mattress.length} · bedframe ${byCat.bedframe.length} · sofa ${byCat.sofa.length} SKUs available`}
            </span>
          </div>

          {/* Preview */}
          {preview.length > 0 && (
            <div style={{ marginTop: 'var(--space-3)', maxHeight: 280, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius-md)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-12)' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', borderBottom: '1px solid var(--line)' }}>
                    <th style={{ padding: '6px 10px' }}>#</th>
                    <th style={{ padding: '6px 10px' }}>Customer</th>
                    <th style={{ padding: '6px 10px' }}>Combo</th>
                    <th style={{ padding: '6px 10px' }}>Lines</th>
                    <th style={{ padding: '6px 10px' }}>Processing Date</th>
                    <th style={{ padding: '6px 10px' }}>Delivery</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(0, 60).map((s, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '5px 10px', color: 'var(--fg-muted)' }}>{i + 1}</td>
                      <td style={{ padding: '5px 10px' }}>{s.customerName}</td>
                      <td style={{ padding: '5px 10px' }}>{s.combo}</td>
                      <td style={{ padding: '5px 10px', color: 'var(--fg-muted)' }}>
                        {s.lines.map((l) => `${l.itemCode}${l.qty > 1 ? `×${l.qty}` : ''}`).join(' + ')}
                      </td>
                      <td style={{ padding: '5px 10px' }}>{fmtDateOrDash(s.processingDate)}</td>
                      <td style={{ padding: '5px 10px' }}>{fmtDateOrDash(s.deliveryDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Card 2 — Pick products (one SO per ticked line) */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Pick products</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={clearPicks} disabled={pickedManual.length === 0}>
              <Square {...ICON} /> Clear
            </Button>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {pickedManual.length} picked · each becomes its own SO
            </span>
          </div>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid2}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Customer *</span>
              <input type="text" value={manualCustomer} onChange={(e) => setManualCustomer(e.target.value)}
                placeholder="e.g. Walk-in / customer name" className={styles.fieldInput} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Processing date</span>
              <DateField fullWidth value={manualProc} min={todayMY()} onChange={(iso) => setManualProc(iso)} className={styles.fieldInput}/>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Delivery date</span>
              <DateField fullWidth value={manualDeliv} min={todayMY()} onChange={(iso) => setManualDeliv(iso)} className={styles.fieldInput}/>
            </label>
          </div>

          <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Button variant="primary" size="md"
              disabled={running || pickedManual.length === 0 || !manualCustomer.trim()}
              onClick={runManual}>
              <CheckSquare {...ICON} /> Generate {pickedManual.length} SO{pickedManual.length === 1 ? '' : 's'}
            </Button>
          </div>

          {/* DataGrid conversion (owner request 2026-06-12) — the browse list
              rides the shared grid (sort / per-column filter / column
              show-hide / reorder / persisted layout). Pick checkboxes + qty
              inputs are controlled by `picks` exactly as before; the legacy
              per-category sticky headers live on as a default group-by
              Category (remove the chip for a flat list). */}
          <div style={{ marginTop: 'var(--space-3)' }}>
            <DataGrid
              rows={products}
              columns={pickColumns}
              storageKey={PICK_GRID_KEY}
              rowKey={(p) => p.code}
              searchPlaceholder="Filter products…"
              isLoading={prodQ.isLoading}
              emptyMessage={prodQ.isError
                ? "We couldn't load the product catalog. That is not the same as it being empty — please refresh and try again."
                : "No products in catalog."}
              rowStyle={(p) => (picks[p.code]?.picked ? { background: 'rgba(213,90,40,0.04)' } : undefined)}
            />
          </div>
        </div>
      </section>
    </div>
  );
};
