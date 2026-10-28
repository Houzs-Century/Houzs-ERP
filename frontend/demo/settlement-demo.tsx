// ----------------------------------------------------------------------------
// The owner's local test harness for layer 3. DEV ONLY — this entry is not part
// of the production build (index.html is), and nothing in src/ imports it.
//
// It mounts the REAL settlement pages — BOTH of them, wired to each other by
// the same links the app uses — against the demo API server
// (backend/scripts/settlement-demo-server.ts), which runs the REAL handlers,
// parser, matcher and posting engine over an in-memory database. Auth, the
// route guard and the sidebar are skipped on purpose: the point is to click
// the reconciliation itself, not to log in.
//
// The ledger panel on the right is the whole reason this exists — confirm a
// settlement on the left, and watch the journal entry appear on the right with
// settlement-in-transit emptying towards zero.
// ----------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import '../src/index.css';
import '../src/vendor/design-system/tokens.css';
import { ToastProvider } from '../src/hooks/useToast';
import { DialogProvider } from '../src/hooks/useDialog';
import { MerchantRecon } from '../src/pages/scm-v2/MerchantRecon';
import { BankRecon } from '../src/pages/scm-v2/BankRecon';
import { SettlementSetup } from '../src/pages/scm-v2/SettlementSetup';
import { fmtSen } from '../src/vendor/shared/format';

// authedFetch refuses to run without a token; the demo server ignores it.
localStorage.setItem('auth:token', 'demo-token');
localStorage.setItem('houzs.activeCompanyId', '1');

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8788';
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

type Ledger = {
  entries: Array<{
    je_no: string; entry_date: string; source_type: string; source_doc_no: string; narration: string;
    lines: Array<{ account_code: string; account_name: string; debit_sen: number; credit_sen: number; notes: string }>;
  }>;
  transitBalanceSen: number;
  payments: Array<{ id: string; so_doc_no?: string; sales_invoice_id?: string; amount_sen: number; merchant_provider: string; approval_code: string | null; paid_at: string }>;
  settledPaymentIds: string[];
};

const LedgerPanel = () => {
  const q = useQuery({
    queryKey: ['demo-ledger'],
    queryFn: async (): Promise<Ledger> => (await fetch(`${API}/api/scm/demo/ledger`)).json(),
    refetchInterval: 1500,
  });
  const led = q.data;
  return (
    <aside style={{
      width: 460, flexShrink: 0, padding: 16, borderLeft: '1px solid rgba(34,31,32,0.15)',
      height: '100vh', overflowY: 'auto', background: 'rgba(0,0,0,0.02)',
    }}>
      <h3 style={{ marginTop: 0 }}>账本 · The ledger</h3>
      <div style={{
        padding: 10, marginBottom: 12, borderRadius: 8,
        background: led && led.transitBalanceSen === 0 ? 'rgba(47,93,79,0.12)' : 'rgba(184,51,31,0.10)',
      }}>
        <div style={{ fontSize: 12, color: '#666' }}>在途结算款 320-0000（对账就是把它清零）</div>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtSen(led?.transitBalanceSen ?? 0)}</div>
      </div>

      <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>
        刷卡收款 {led?.payments.length ?? 0} 笔，已结算 {led?.settledPaymentIds.length ?? 0} 笔
      </div>

      <h4>过账凭证 ({led?.entries.length ?? 0})</h4>
      {(led?.entries ?? []).length === 0 && (
        <div style={{ fontSize: 13, color: '#888' }}>
          还没有任何分录。确认一笔配对，这里就会出现 —— 这正是系统 3 从来没做到的事。
        </div>
      )}
      {(led?.entries ?? []).map((je) => (
        <div key={je.je_no} style={{ marginBottom: 12, padding: 10, border: '1px solid rgba(34,31,32,0.15)', borderRadius: 8, background: '#fff' }}>
          <div style={{ fontWeight: 700 }}>{je.je_no} · {je.entry_date} · {je.source_type}</div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{je.narration}</div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <tbody>
              {je.lines.map((l, i) => (
                <tr key={i}>
                  <td style={{ padding: '2px 4px' }}>{l.account_code}</td>
                  <td style={{ padding: '2px 4px' }}>{l.account_name}</td>
                  <td style={{ padding: '2px 4px', textAlign: 'right' }}>{l.debit_sen ? fmtSen(l.debit_sen) : ''}</td>
                  <td style={{ padding: '2px 4px', textAlign: 'right' }}>{l.credit_sen ? fmtSen(l.credit_sen) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </aside>
  );
};

/* Must match what is actually in demo-statements/ — this list names the files
   the operator is told to try, so a name that no longer exists sends him
   looking for a file that is not there. */
const SAMPLES = [
  { name: 'MBB-credit-Aug.csv', label: 'MBB 信用卡（有唯一编号 → 会自动配对）' },
  { name: 'MBB-instalment-Aug.csv', label: 'MBB 分期（fee 比较重）' },
  { name: 'GHL-Aug.csv', label: 'GHL 报表（没编号 → 一律要人确认）' },
  { name: 'HLB-Aug.csv', label: 'HLB（日期没有年份 → 会问你是哪个月）' },
  { name: 'AEON-Aug.csv', label: 'AEON（xlsx 那种，还有一笔报表自己的收费）' },
  { name: 'PBB-2990HOME-Jun.csv', label: 'PBB（2990 的，收钱银行跟 Houzs 不同）' },
  { name: 'PBB-IBG-advice-Jun.pdf', label: 'PBB 的 payment advice（跟上面那份 PBB 报表配对；Bank 页的 Payment advice 用）' },
  { name: 'MBB-one-swipe-two-orders.csv', label: '一次刷卡还两张单（两张 SO 同一个 approval code → 自动对上）' },
  { name: 'wrong-file.csv', label: '传错的档案（应该被指名拒绝）' },
  { name: 'BANK-MBB-Aug.csv', label: '银行月结单（第二页 Bank statement 用；MBB 真实格式）' },
  { name: 'BANK-PBB-Jun.csv', label: '银行月结单：PBB 那笔 RM 11,814.44 进帐（配 advice 的最后一步）' },
];

const Harness = () => {
  const [resetAt, setResetAt] = useState(0);
  useEffect(() => { document.title = 'Card settlement — local test'; }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <main style={{ flex: 1, padding: 16, height: '100vh', overflowY: 'auto' }}>
        <div style={{
          padding: 10, marginBottom: 14, borderRadius: 8, fontSize: 13,
          background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(160,120,0,0.35)',
        }}>
          <b>本地测试台</b> —— 真的页面、真的解析、真的配对、真的过账引擎；只有资料库是记忆体里的假资料，
          不碰任何正式帐本。测试档案在 <code>demo-statements/</code>：
          <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
            {SAMPLES.map((s) => (
              <li key={s.name}><code>{s.name}</code> —— {s.label}</li>
            ))}
          </ul>
          <button
            type="button"
            style={{ marginLeft: 10, padding: '4px 10px', cursor: 'pointer' }}
            onClick={() => {
              void fetch(`${API}/api/scm/demo/reset`, { method: 'POST' }).then(() => {
                queryClient.clear();
                setResetAt((n) => n + 1);
              });
            }}
          >
            重来一次
          </button>
        </div>
        {/* Both real screens, on their real paths, so the hand-off between
            them is exercised too: reconcile here, then "Money into the bank". */}
        <Routes key={resetAt}>
          <Route path="/scm/bank-recon" element={<BankRecon />} />
          <Route path="/scm/settlement-setup" element={<SettlementSetup />} />
          <Route path="*" element={<MerchantRecon />} />
        </Routes>
      </main>
      <LedgerPanel />
    </div>
  );
};

/* MemoryRouter, not BrowserRouter: this page is served as a static file, so a
   real URL push would 404 on reload. In-memory routing lets the two screens
   link to each other exactly as they do in the app. */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DialogProvider>
          <Harness />
        </DialogProvider>
      </ToastProvider>
    </QueryClientProvider>
  </MemoryRouter>,
);
