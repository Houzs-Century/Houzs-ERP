// ----------------------------------------------------------------------------
// PartTimePay — a part-time salesperson's pay for an event (owner 2026-10-14):
// 2% of their sales at the event, RM 120 a day counted from their POS logins
// (the first login of the day is their arrival), one RM 20 WiFi allowance per
// event. The owner keys the sheet with the bank details, HR confirms a row —
// which raises the payment request — Finance pays one voucher per person and
// attaches the bank slip, which reads back here for HR and the owner.
// Server: backend/src/scm/routes/hr-part-time-pay.ts. Rates: HR Settings.
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@2990s/design-system';
import {
  fetchPartTimeSlipUrl, previewAmounts, useConfirmPartTimeRow, usePartTimeEvents, usePartTimeSheet, useRemovePartTimeRow, useSavePartTimeSheet,
  type RowInput, type SheetLine,
} from '../../vendor/scm/lib/part-time-pay-queries';
import { STAGE } from '../../vendor/scm/lib/payment-request-queries';
import { eventLabel } from '../../vendor/scm/lib/event-queries';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { PageHeader } from '../../components/Layout';
import { fmtDate, fmtSen, fmtTime } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

type Draft = { include: boolean; days: string; wifi: boolean; bankName: string; bankAccountNo: string; bankAccountName: string; note: string };

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const cell: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top', borderBottom: '1px solid var(--line)' };
const head: React.CSSProperties = { ...cell, fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
const input: React.CSSProperties = { width: '100%', padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg, #fff)', fontSize: 'var(--fs-13)' };
const right: React.CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap' };

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

const draftOf = (l: SheetLine): Draft => (l.saved
  ? { include: true, days: String(l.saved.days), wifi: l.saved.wifi_sen > 0, bankName: l.saved.bank_name ?? '', bankAccountNo: l.saved.bank_account_no ?? '', bankAccountName: l.saved.bank_account_name ?? '', note: l.saved.note ?? '' }
  : { include: false, days: String(l.suggestedDays), wifi: false, bankName: '', bankAccountNo: '', bankAccountName: '', note: '' });

const parseEvent = (raw: string | null): number | null => {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : null;
};

export const PartTimePay = () => {
  const [params, setParams] = useSearchParams();
  const projectId = parseEvent(params.get('event'));
  const [q, setQ] = useState('');
  const eventsQ = usePartTimeEvents(q);
  const sheetQ = usePartTimeSheet(projectId);
  const save = useSavePartTimeSheet();
  const remove = useRemovePartTimeRow();
  const confirmRow = useConfirmPartTimeRow();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const [draft, setDraft] = useState<Record<string, Draft | undefined>>({});
  const [opening, setOpening] = useState<string | null>(null);

  const sheet = sheetQ.data ?? null;
  const lines = useMemo(() => sheet?.lines ?? [], [sheet]);

  /* The server's sheet is the truth; what the owner types rides on top of it
     until saved, and is re-read after every save. */
  useEffect(() => {
    setDraft(Object.fromEntries(lines.map((l) => [l.staffId, draftOf(l)])));
  }, [lines]);

  const edit = (staffId: string, patch: Partial<Draft>) => setDraft((prev) => ({ ...prev, [staffId]: { ...(prev[staffId] ?? draftOf(lines.find((l) => l.staffId === staffId)!)), ...patch } }));
  const tickWifi = (staffId: string) => setDraft((prev) => Object.fromEntries(Object.entries(prev).map(([id, d]) => [id, d ? { ...d, wifi: id === staffId ? !d.wifi : false } : d])));

  const editable = (l: SheetLine) => !!sheet?.canRequest && l.saved?.status !== 'CONFIRMED';
  const rowsToSave = (): RowInput[] => lines
    .filter((l) => editable(l) && (draft[l.staffId]?.include ?? false))
    .map((l) => {
      const d = draft[l.staffId] ?? draftOf(l);
      const trim = (s: string) => (s.trim() ? s.trim() : null);
      return { staffId: l.staffId, days: Number(d.days), wifi: d.wifi, bankName: trim(d.bankName), bankAccountNo: trim(d.bankAccountNo), bankAccountName: trim(d.bankAccountName), note: trim(d.note) };
    });

  const onSave = async () => {
    if (!sheet) return;
    const rows = rowsToSave();
    if (rows.length === 0) { void notify({ title: 'Nothing to save', body: 'Tick the part-timers to put on the sheet first.' }); return; }
    const bad = rows.find((r) => !Number.isInteger(r.days) || r.days < 0);
    if (bad) { void notify({ title: 'Days', body: 'Days worked must be a whole number.', tone: 'error' }); return; }
    await save.mutateAsync({ projectId: sheet.event.id, rows });
    void notify({ title: 'Sheet saved', body: `${rows.length} row${rows.length === 1 ? '' : 's'} saved for HR to confirm.` });
  };

  const onRemove = async (l: SheetLine) => {
    if (!l.saved) return;
    const ok = await askConfirm({ title: `Remove ${l.staffName} from the sheet?`, body: 'The row goes; the POS logins and sales stay.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    await remove.mutateAsync(l.saved.id);
  };

  const onConfirm = async (l: SheetLine) => {
    if (!l.saved) return;
    const ok = await askConfirm({
      title: `Confirm ${l.staffName}'s pay — ${fmtSen(l.saved.total_sen)}?`,
      body: <span>{l.saved.breakdown}<br />A payment request goes to Finance for {l.saved.bank_account_name || l.staffName}{l.saved.bank_account_no ? ` · ${l.saved.bank_name ?? ''} ${l.saved.bank_account_no}` : ''}.</span>,
      confirmLabel: 'Confirm and send to Finance',
    });
    if (!ok) return;
    const r = await confirmRow.mutateAsync(l.saved.id);
    void notify({ title: 'Sent to Finance', body: `${r.request.requestNo} raised for ${l.staffName}.` });
  };

  const openSlip = async (rowId: string, fileId: string) => {
    setOpening(fileId);
    try {
      const { url } = await fetchPartTimeSlipUrl(rowId, fileId);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    } catch (e) {
      void notify({ title: 'Slip not opened', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    } finally {
      setOpening(null);
    }
  };

  const rates = sheet?.rates ?? null;
  const dirty = lines.some((l) => editable(l) && (draft[l.staffId]?.include ?? false));

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="HR" title="Part-time sales pay · 兼职销售工资" />

      <section className={styles.card}>
        <div className={styles.cardHeader} style={{ flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260 }}>
            <span style={soft}>Event</span>
            <select aria-label="Event" style={input} value={projectId ?? ''} onChange={(e) => setParams(e.target.value ? { event: e.target.value } : {})}>
              <option value="">— Pick the event —</option>
              {(eventsQ.data?.events ?? []).map((e) => <option key={e.id} value={e.id}>{eventLabel(e)}</option>)}
              {projectId != null && sheet && !(eventsQ.data?.events ?? []).some((e) => e.id === projectId) && <option value={projectId}>{eventLabel(sheet.event)}</option>}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
            <span style={soft}>Find an event</span>
            <input aria-label="Find an event" style={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, venue, brand…" />
          </label>
          {rates && (
            <span style={soft}>
              {pct(rates.commissionBps)} of sales · {fmtSen(rates.dayRateSen)} a day · WiFi {fmtSen(rates.wifiSen)} for one person per event · <Link to="/scm/hr/settings">change in HR Settings</Link>
            </span>
          )}
        </div>

        <div className={styles.cardBody}>
          {projectId == null && <p style={soft}>Pick the event. Everyone who logged into the POS or sold during it is listed with their days, arrival times and sales.</p>}
          {projectId != null && sheetQ.isLoading && <p style={soft}>Loading…</p>}
          {projectId != null && sheetQ.isError && <p style={{ color: 'var(--c-festive-b, #B8331F)' }}>The sheet could not be loaded — {sheetQ.error instanceof Error ? sheetQ.error.message : 'something went wrong.'}</p>}
          {sheet && (
            <>
              <p style={{ marginBottom: 8 }}>
                <strong>{sheet.event.name}</strong>{' '}
                <span style={soft}>{sheet.event.startDate ? fmtDate(sheet.event.startDate) : '—'}{sheet.event.endDate && sheet.event.endDate !== sheet.event.startDate ? ` to ${fmtDate(sheet.event.endDate)}` : ''}{sheet.event.venue ? ` · ${sheet.event.venue}` : ''}</span>
                <br />
                <span style={soft}>On the voucher and the receipt: {sheet.purpose}</span>
              </p>
              {lines.length === 0 ? (
                <p style={soft}>Nobody logged into the POS or sold anything during this event yet.</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table aria-label="Part-time pay sheet" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-13)' }}>
                    <thead>
                      <tr>
                        <th style={head}>On sheet</th>
                        <th style={head}>Salesperson</th>
                        <th style={head}>Days at the POS</th>
                        <th style={head}>Days paid</th>
                        <th style={{ ...head, textAlign: 'right' }}>Sales</th>
                        <th style={{ ...head, textAlign: 'right' }}>Commission</th>
                        <th style={{ ...head, textAlign: 'right' }}>Day pay</th>
                        <th style={head}>WiFi</th>
                        <th style={{ ...head, textAlign: 'right' }}>Total</th>
                        <th style={head}>Bank</th>
                        <th style={head}>Account no</th>
                        <th style={head}>Account name</th>
                        <th style={head}>Note</th>
                        <th style={head}>Status</th>
                        <th style={head}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => {
                        const d = draft[l.staffId] ?? draftOf(l);
                        const canEdit = editable(l);
                        const saved = l.saved;
                        const figures = saved && saved.status === 'CONFIRMED'
                          ? { commissionSen: saved.commission_sen, salarySen: saved.salary_sen, wifiSen: saved.wifi_sen, totalSen: saved.total_sen }
                          : previewAmounts({ days: Number(d.days), salesSen: l.salesSen, wifi: d.wifi, rates: sheet.rates });
                        const answer = saved?.answer ?? null;
                        return (
                          <tr key={l.staffId} data-testid={`row-${l.staffId}`}>
                            <td style={cell}>
                              {saved
                                ? <span style={soft}>{saved.status === 'CONFIRMED' ? 'Confirmed' : 'Saved'}</span>
                                : <input type="checkbox" aria-label={`Put ${l.staffName} on the sheet`} checked={d.include} disabled={!sheet.canRequest} onChange={(e) => edit(l.staffId, { include: e.target.checked })} />}
                            </td>
                            <td style={cell}>
                              <div>{l.staffName}</div>
                              {l.staffCode && <div style={soft}>{l.staffCode}</div>}
                            </td>
                            <td style={cell}>
                              <div>{l.suggestedDays} day{l.suggestedDays === 1 ? '' : 's'}</div>
                              <ul aria-label={`${l.staffName}'s days`} style={{ ...soft, listStyle: 'none', margin: 0, padding: 0 }}>
                                {l.days.map((day) => (
                                  <li key={day.date}>
                                    {fmtDate(day.date)} · {day.firstLoginAt ? `in ${fmtTime(day.firstLoginAt)}` : 'no login'}{day.lastLogoutAt ? ` · out ${fmtTime(day.lastLogoutAt)}` : ''}{day.orders > 0 ? ` · ${day.orders} order${day.orders === 1 ? '' : 's'}` : ''}
                                  </li>
                                ))}
                              </ul>
                            </td>
                            <td style={cell}>
                              {canEdit
                                ? <input type="number" min={0} max={60} step={1} aria-label={`${l.staffName} days paid`} style={{ ...input, width: 64 }} value={d.days} onChange={(e) => edit(l.staffId, { days: e.target.value })} disabled={!d.include && !saved} />
                                : <span>{saved?.days ?? d.days}</span>}
                            </td>
                            <td style={right}>
                              {fmtSen(l.salesSen)}
                              {l.orderCount > 0 && <div style={soft}>{l.orderCount} order{l.orderCount === 1 ? '' : 's'}</div>}
                              {l.salesChanged && <div style={{ ...soft, color: 'var(--c-festive-b, #B8331F)' }}>changed since saved ({fmtSen(saved?.sales_sen ?? 0)}) — save again</div>}
                            </td>
                            <td style={right}>{fmtSen(figures.commissionSen)}</td>
                            <td style={right}>{fmtSen(figures.salarySen)}</td>
                            <td style={cell}>
                              {canEdit
                                ? <input type="checkbox" aria-label={`WiFi allowance to ${l.staffName}`} checked={d.wifi} disabled={!d.include && !saved} onChange={() => tickWifi(l.staffId)} />
                                : <span>{figures.wifiSen > 0 ? fmtSen(figures.wifiSen) : '—'}</span>}
                            </td>
                            <td style={{ ...right, fontWeight: 600 }}>{fmtSen(figures.totalSen)}</td>
                            <td style={cell}>{canEdit ? <input aria-label={`${l.staffName} bank`} style={{ ...input, minWidth: 110 }} value={d.bankName} disabled={!d.include && !saved} onChange={(e) => edit(l.staffId, { bankName: e.target.value })} /> : (saved?.bank_name ?? '—')}</td>
                            <td style={cell}>{canEdit ? <input aria-label={`${l.staffName} account no`} style={{ ...input, minWidth: 130 }} value={d.bankAccountNo} disabled={!d.include && !saved} onChange={(e) => edit(l.staffId, { bankAccountNo: e.target.value })} /> : (saved?.bank_account_no ?? '—')}</td>
                            <td style={cell}>{canEdit ? <input aria-label={`${l.staffName} account name`} style={{ ...input, minWidth: 150 }} value={d.bankAccountName} disabled={!d.include && !saved} onChange={(e) => edit(l.staffId, { bankAccountName: e.target.value })} /> : (saved?.bank_account_name ?? '—')}</td>
                            <td style={cell}>{canEdit ? <input aria-label={`${l.staffName} note`} style={{ ...input, minWidth: 140 }} value={d.note} disabled={!d.include && !saved} onChange={(e) => edit(l.staffId, { note: e.target.value })} /> : (saved?.note ?? '—')}</td>
                            <td style={{ ...cell, minWidth: 220 }}>
                              {!saved && <span style={soft}>Not on the sheet</span>}
                              {saved && saved.status === 'DRAFT' && (
                                <span style={{ color: 'var(--c-orange)' }}>Keyed by {saved.requested_by_name ?? '—'}, waiting for HR · 待HR确认</span>
                              )}
                              {saved && saved.status === 'CONFIRMED' && (
                                <div>
                                  <div>Confirmed by {saved.confirmed_by ?? 'HR'}{answer ? <> · <Link to={`/scm/payment-requests?open=${encodeURIComponent(answer.id)}`} style={{ fontFamily: 'var(--font-mono)' }}>{answer.requestNo}</Link></> : null}</div>
                                  {answer && <div style={{ color: STAGE[answer.stage].tone }}>{STAGE[answer.stage].label}{answer.voucher?.pvNumber ? ` · ${answer.voucher.pvNumber}` : ''}</div>}
                                  {answer?.financeNote && <div style={soft}>Finance: {answer.financeNote}</div>}
                                  {answer && answer.slips.length > 0 && (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                                      {answer.slips.map((f) => (
                                        <button key={f.id} type="button" disabled={opening === f.id} onClick={() => void openSlip(saved.id, f.id)}
                                          style={{ padding: '2px 8px', borderRadius: 999, border: '1px solid var(--line)', background: 'transparent', fontSize: 'var(--fs-12)', cursor: 'pointer' }}>
                                          {opening === f.id ? 'Opening…' : `Bank slip · ${f.fileName}`}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {answer && answer.slips.length === 0 && <div style={soft}>No bank slip attached yet.</div>}
                                </div>
                              )}
                            </td>
                            <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                              {saved && saved.status === 'DRAFT' && sheet.canConfirm && (
                                <Button variant="primary" size="sm" disabled={confirmRow.isPending || l.salesChanged} title={l.salesChanged ? 'The sales changed since the sheet was saved — ask the requester to save again.' : undefined} onClick={() => void onConfirm(l)}>
                                  Confirm
                                </Button>
                              )}
                              {saved && saved.status === 'DRAFT' && sheet.canRequest && (
                                <Button variant="secondary" size="sm" disabled={remove.isPending} onClick={() => void onRemove(l)} style={{ marginLeft: 6 }}>Remove</Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {sheet.canRequest && lines.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
                  <Button variant="primary" disabled={save.isPending || !dirty} onClick={() => void onSave()}>Save sheet</Button>
                  <span style={soft}>Saved rows wait for HR to confirm; the confirm sends the payment request to Finance.</span>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
};
