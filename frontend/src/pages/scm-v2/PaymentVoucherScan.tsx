// ----------------------------------------------------------------------------
// PaymentVoucherScan — the bill pile, read and grouped, at
// /scm/payment-vouchers/scan.
//
// The owner's three cases (2026-09-02), his taxonomy exactly:
//   1. 一张bill 几页   — tick the pages, press 合并: they become ONE bill;
//   2. 一个supplier 多张单 — recognised bills GROUP by supplier, and a group
//      opens as ONE voucher, one line per bill (a statement payment);
//   3. 多个supplier 多个单 — every other group/bill opens separately.
//
// The rule that keeps it honest: ONE FILE = ONE BILL unless a human merged
// pages at upload. The reader never guesses whether two files are one
// document. And NOTHING saves here — each "Open as voucher" lands on the New
// page pre-filled, where a person picks the account, checks the figures and
// saves through the untouched approval cycle.
//
// The same pile serves the AP INVOICES (target="ap", at /scm/ap-invoices/scan;
// owner 2026-09-08: 我可能同时 upload 多张 supplier 给的 invoice, 所以要分出来
// 一张一张): the reading and the merge are identical, but every bill opens as
// ITS OWN AP invoice — a bill is an invoice with its own number, so there is
// no "one voucher for the group" here.
//
// Case 4 (owner 2026-09-08: 因为我是三个 receipt 开一张 voucher 罢了): DIFFERENT
// receipts — different shops — on ONE petty-cash voucher. Read them first,
// tick them across groups, "Open ticked as ONE voucher": one line per receipt
// (what was bought as read, at the receipt's total), the payee LEFT for the person (three
// shops have no one payee, and no vendor memory is borrowed), every receipt's
// pages attached. Not the Merge — Merge makes PAGES of one bill; this makes
// LINES of one voucher. He pressed Merge for it and the reader, told those
// three receipts were one document, read one.
//
// ONE BILL PER REQUEST (owner 2026-10-05: four bills sent together took past
// the 30-second wait and the page said "couldn't confirm whether it saved" —
// 同时 upload 多 must work). Each bill goes to the reader on its own, three at
// a time; each lands as it is read, a slow or bad bill holds up only itself
// and can be read again alone, and a bill printed on something already
// entered says so (lib/bill-matches.ts — a warning, never a block).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, FileText, X } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useExtractBills, fileToBase64, type ExtractedBill, type BillExtraction, type VendorMemory, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { useBillMatches } from '../../vendor/scm/lib/payment-request-queries';
import { BillMatchesNote } from '../../vendor/scm/components/RequestBill';
import type { EventSuggestion } from '../../vendor/scm/lib/event-queries';
import { stashPvFiles } from '../../vendor/scm/lib/pv-file-handoff';
import { fmtDate } from '../../vendor/shared/format';
import { PageHeader } from '../../components/Layout';
import styles from './SalesOrderDetail.module.css';

import { fmtSen } from '../../vendor/shared/format';
const ICON = { size: 16, strokeWidth: 1.75 } as const;

const ACCEPT_MIMES = 'image/jpeg,image/png,image/webp,application/pdf';
/* How many bills are with the reader at once — the rest wait their turn. */
export const READ_AT_ONCE = 3;
/* A pile, not a dropped folder (owner 2026-10-05: 一次最多 50 张). */
export const MAX_PILE_FILES = 50;

const fmtRm = (sen: number | null | undefined): string => fmtSen(sen);

type PickedFile = { rid: string; file: File; merged: boolean };

/* Another live request, voucher or AP invoice printed with this bill's number
   and date — said beside the bill before it is opened. */
const PileBillMatches = ({ no, date }: { no: string | null; date: string | null }) => {
  const q = useBillMatches(no ?? '', date ?? '');
  return <BillMatchesNote matches={q.data?.matches} />;
};

export const PaymentVoucherScan = ({ target = 'pv' }: { target?: 'pv' | 'ap' } = {}) => {
  const ap = target === 'ap';
  const navigate = useNavigate();
  const extract = useExtractBills();

  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /* bills[i] = the rids that form bill i (merged pages share an entry). */
  const [billGroups, setBillGroups] = useState<string[][]>([]);
  const [results, setResults] = useState<ExtractedBill[] | null>(null);
  /* The read payload, kept by bill index — the voucher created from a bill
     carries these as attachments (owner 2026-09-03: print pv include ocr 的
     文件一起 — nothing to print if nothing was kept). */
  const [billFiles, setBillFiles] = useState<PvFilePayload[][]>([]);
  const [splitGroups, setSplitGroups] = useState<Set<string>>(new Set());
  /* Case 4: the read bills (by index) ticked for ONE voucher across groups. */
  const [tickedForOne, setTickedForOne] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  /* The read under way: how many bills are answered of how many sent. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /* Failed bills being read again, one at a time each. */
  const [rereading, setRereading] = useState<Set<number>>(new Set());
  /* While the reader has bills the pile holds still — an answer lands by its
     place in the pile, so the pile may not shift under it. */
  const busy = progress != null || rereading.size > 0;

  /* The same allowlist the server enforces — a dropped .docx is refused at the
     door with a sentence, not uploaded to fail later. ONE home: the string
     feeds both the picker's accept= and the drop/paste filter. */
  const accepted = (f: File) => ACCEPT_MIMES.split(',').includes(f.type) || /\.pdf$/i.test(f.name);

  const addFileArray = (files: File[]) => {
    if (busy) return;
    const usable = files.filter(accepted);
    const taken = usable.slice(0, Math.max(0, MAX_PILE_FILES - picked.length));
    const said = [
      usable.length < files.length ? 'Some files were skipped — JPEG / PNG / WebP / PDF only.' : null,
      taken.length < usable.length
        ? `A pile holds at most ${MAX_PILE_FILES} files — ${usable.length - taken.length} left out. Read these first, then add the rest.`
        : null,
    ].filter(Boolean).join(' ');
    if (said) setNote(said);
    if (taken.length === 0) return;
    const next = taken.map((f) => ({ rid: `f${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, file: f, merged: false }));
    setPicked((prev) => [...prev, ...next]);
    setBillGroups((prev) => [...prev, ...next.map((p) => [p.rid])]);
    setResults(null);
  };
  const addFiles = (list: FileList | null) => { if (list) addFileArray([...list]); };

  /* 拖进来就收 (the owner, 2026-09-02: 我无法从我的folder 拖动进来upload) —
     and Ctrl+V for a screenshot of a bill. The listener is set once and calls
     the latest adder, so it sees the pile (and its cap) as it is now. */
  const [dragOver, setDragOver] = useState(false);
  const addLatest = useRef(addFileArray);
  useEffect(() => { addLatest.current = addFileArray; });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length > 0) addLatest.current(files);
    };
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('paste', onPaste); };
  }, []);

  /* 合并所选 — the ticked files become ONE bill (case 1). */
  const mergeTicked = () => {
    if (ticked.size < 2 || busy) return;
    setBillGroups((prev) => {
      const kept = prev.filter((g) => !g.some((rid) => ticked.has(rid)));
      const mergedRids = prev.flat().filter((rid) => ticked.has(rid));
      return [...kept, [mergedRids].flat().length > 0 ? mergedRids : []].filter((g) => g.length > 0);
    });
    setPicked((prev) => prev.map((p) => (ticked.has(p.rid) ? { ...p, merged: true } : p)));
    setTicked(new Set());
    setResults(null);
  };

  const removeFile = (rid: string) => {
    if (busy) return;
    setPicked((prev) => prev.filter((p) => p.rid !== rid));
    setBillGroups((prev) => prev.map((g) => g.filter((r) => r !== rid)).filter((g) => g.length > 0));
    setResults(null);
  };

  /* A bill's answer, put in its place in the pile (a read-again replaces the old one). */
  const land = (b: ExtractedBill) =>
    setResults((prev) => [...(prev ?? []).filter((r) => r.index !== b.index), b].sort((x, y) => x.index - y.index));

  /* ONE bill to the reader — its own request, its own wait. A bill that cannot
     be read (or a reader that took too long) is that bill's answer, never the
     pile's. */
  const readBill = async (index: number, rids: string[], byRid: Map<string, File>): Promise<void> => {
    let files: PvFilePayload[];
    try {
      files = await Promise.all(rids.map(async (rid) => {
        const f = byRid.get(rid)!;
        return { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) };
      }));
    } catch (e) {
      land({ index, ok: false, reason: e instanceof Error ? e.message : 'The file could not be read from disk.' });
      return;
    }
    setBillFiles((prev) => { const n = [...prev]; n[index] = files; return n; });
    try {
      const got = (await extract.mutateAsync([{ files }])).bills.at(0);
      land(got ? { ...got, index } : { index, ok: false, reason: 'The reader sent nothing back — read it again.' });
    } catch (e) {
      land({ index, ok: false, reason: e instanceof Error ? e.message : 'The bill could not be read.' });
    }
  };

  const run = async () => {
    if (busy || billGroups.length === 0) return;
    const pile = billGroups;
    const byRid = new Map(picked.map((p) => [p.rid, p.file]));
    setResults([]);
    setBillFiles([]);
    setTickedForOne(new Set());
    setNote(null);
    setProgress({ done: 0, total: pile.length });
    let next = 0;
    /* READ_AT_ONCE lanes, each taking the next bill as its last one lands. */
    const lane = async () => {
      while (next < pile.length) {
        const i = next++;
        await readBill(i, pile[i]!, byRid);
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, pile.length) }, lane));
    setProgress(null);
  };

  const readAgain = async (index: number) => {
    const rids = billGroups.at(index);
    if (!rids || busy) return;
    setRereading((prev) => new Set(prev).add(index));
    await readBill(index, rids, new Map(picked.map((p) => [p.rid, p.file])));
    setRereading((prev) => { const n = new Set(prev); n.delete(index); return n; });
  };
  /* The files a bill was made of, by name — how a failed bill is told apart. */
  const namesOf = (index: number): string => {
    const byRid = new Map(picked.map((p) => [p.rid, p.file.name]));
    return (billGroups[index] ?? []).map((rid) => byRid.get(rid) ?? '').filter(Boolean).join(' + ');
  };

  /* Group the READ bills by matched supplier; unmatched ones group by the
     printed vendor name so two TNB bills still sit together. */
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; supplierId: string | null; bills: Array<Extract<ExtractedBill, { ok: true }>> }>();
    for (const b of results ?? []) {
      if (!b.ok) continue;
      const key = b.supplierMatch ? `s:${b.supplierMatch.id}` : `v:${(b.extraction.vendorName ?? `bill-${b.index}`).toUpperCase()}`;
      const cur = map.get(key) ?? {
        label: b.supplierMatch?.name ?? b.extraction.vendorName ?? `Unnamed bill ${b.index + 1}`,
        supplierId: b.supplierMatch?.id ?? null,
        bills: [],
      };
      cur.bills.push(b);
      map.set(key, cur);
    }
    return [...map.entries()].map(([key, g]) => ({ key, ...g }));
  }, [results]);

  const openVoucher = (extraction: BillExtraction, extras?: { lines?: Array<{ description: string | null; amountSen: number | null }>; memory?: VendorMemory | null; files?: PvFilePayload[]; eventSuggestions?: EventSuggestion[] }) => {
    /* The bill's own bytes ride ALONG (module stash, not location.state — see
       pv-file-handoff.ts): the New page attaches them once the voucher saves,
       so the evidence lives with the document instead of dying with this tab.
       Stashed even when empty, so a stale earlier pile can't attach here. */
    stashPvFiles(extras?.files ?? []);
    navigate('/scm/payment-vouchers/new', { state: { billPrefill: { extraction, ...(extras?.lines ? { lines: extras.lines } : {}), memory: extras?.memory ?? null, ...(extras?.eventSuggestions ? { eventSuggestions: extras.eventSuggestions } : {}) } } });
  };

  /* 扫 → bill (the owner, 2026-09-03, confirming the flow himself: 他是扫
     bill, 然后帮我录入 bill. 几时要还是我会开 ap payment 去还 — 对). This
     button only RECORDS the debt: it lands on New Purchase Invoice with the
     extraction (and the matched supplier when the reader recognised one);
     paying stays a separate AP Payment, whenever he chooses. */
  const openBill = (
    extraction: BillExtraction,
    supplierId: string | null,
    lines?: Array<{ description: string | null; amountSen: number | null }>,
  ) => {
    navigate('/scm/purchase-invoices/new', { state: { scanBill: { extraction, supplierId, ...(lines ? { lines } : {}) } } });
  };

  /* One bill = one AP invoice (target="ap"): the list page opens its New form
     pre-filled from this bill, the pages riding the same stash the voucher
     uses, attached on save. */
  const openApInvoice = (b: Extract<ExtractedBill, { ok: true }>) => {
    stashPvFiles(billFiles[b.index] ?? []);
    navigate('/scm/ap-invoices', { state: { apPrefill: { extraction: b.extraction, supplierMatch: b.supplierMatch, memory: b.memory, eventSuggestions: b.eventSuggestions ?? [] } } });
  };

  /* Case 4 — the ticked receipts, whatever shop each came from, as ONE voucher. */
  const okBills = useMemo(() => (results ?? []).filter((b): b is Extract<ExtractedBill, { ok: true }> => b.ok), [results]);
  const failedCount = (results ?? []).length - okBills.length;
  const labelOf = (b: Extract<ExtractedBill, { ok: true }>) => b.supplierMatch?.name ?? b.extraction.vendorName ?? `Unnamed bill ${b.index + 1}`;
  const tickedBills = okBills.filter((b) => tickedForOne.has(b.index));
  const tickedCurrencies = new Set(tickedBills.map((b) => b.extraction.currency));
  const openTickedAsOne = () => {
    if (tickedBills.length < 2 || tickedCurrencies.size > 1) return;
    /* One line per receipt, at the receipt's total, described by WHAT WAS
       BOUGHT — the item descriptions the reader found, joined — not by the
       shop (owner 2026-09-08, seeing "99 SPEEDMART" where the pile had shown
       "EVEREADY SHD AAA…": 他 detect 的 description 是对的, 但是转去 voucher 就变
       名字了). The shop + number is the fallback for a receipt with no
       readable item; the shop is always on the attached page. */
    const lines = tickedBills.map((b) => {
      const bought = b.extraction.lines
        .filter((l) => l.description && l.amountSen != null && l.amountSen > 0)
        .map((l) => l.description!.trim()).filter(Boolean).join(' · ');
      return {
        description: bought ? bought.slice(0, 200) : [labelOf(b), b.extraction.invoiceNumber].filter(Boolean).join(' '),
        amountSen: b.extraction.totalSen,
      };
    });
    const first = tickedBills[0]!;
    const dates = tickedBills.map((b) => b.extraction.invoiceDate).filter((d): d is string => !!d).sort();
    openVoucher(
      {
        ...first.extraction,
        /* Three shops have no one payee: left blank for the person, and no
           shop's vendor memory (payee, account) is borrowed for the lot. */
        vendorName: null, vendorRegNo: null, documentKind: 'receipt', sstSen: null, dueDate: null,
        invoiceDate: dates.length > 0 ? dates[dates.length - 1]! : null,
        invoiceNumber: tickedBills.map((b) => b.extraction.invoiceNumber).filter(Boolean).join(', ') || null,
        totalSen: tickedBills.every((b) => b.extraction.totalSen != null)
          ? tickedBills.reduce((s, b) => s + (b.extraction.totalSen ?? 0), 0)
          : null,
        lines,
      },
      /* Every ticked receipt's pages, in bill order — the voucher carries all
         its evidence. */
      { lines, memory: null, files: tickedBills.flatMap((b) => billFiles[b.index] ?? []) },
    );
  };

  const openGroupAsOne = (g: { label: string; bills: Array<Extract<ExtractedBill, { ok: true }>> }) => {
    const first = g.bills[0]!;
    const lines = g.bills.map((b) => ({
      description: [g.label, b.extraction.invoiceNumber].filter(Boolean).join(' '),
      amountSen: b.extraction.totalSen,
    }));
    /* One vendor per group by construction, so the first bill's memory IS the
       group's. */
    openVoucher(
      { ...first.extraction, invoiceNumber: g.bills.map((b) => b.extraction.invoiceNumber).filter(Boolean).join(', ') || null },
      /* Every member bill's pages, in bill order — the ONE voucher carries the
         whole statement's evidence. */
      { lines, memory: first.memory, files: g.bills.flatMap((b) => billFiles[b.index] ?? []) },
    );
  };

  return (
    <div className="space-y-4">
      <PageHeader back eyebrow="Finance" title={ap ? 'Scan bills — AP invoices' : 'Scan bills'} />

      <section
        className={styles.card}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => { setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFileArray([...e.dataTransfer.files]); }}
        style={dragOver ? { outline: '2px dashed var(--c-orange)', outlineOffset: -4 } : undefined}
      >
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>The pile</h2>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            {ap ? 'one file = one bill = one AP invoice, however many pages' : 'one file = one bill, however many pages'} · Merge is only for ONE bill photographed in pieces{ap ? '' : ' · several receipts on ONE voucher: read them, then tick them below'}
          </span>
        </div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
            Drag files here, paste a screenshot (Ctrl+V), or
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)' }}>
              <Camera {...ICON} /> Add bills
              <input type="file" multiple accept={ACCEPT_MIMES}
                aria-label="Add bill files" style={{ display: 'none' }} disabled={busy}
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            </label>
            <Button variant="secondary" size="sm" onClick={mergeTicked} disabled={ticked.size < 2 || busy}>
              {ticked.size > 1 ? `These ${ticked.size} files are pages of ONE bill — merge` : 'Pages of one bill — merge'}
            </Button>
            <span style={{ flex: 1 }} />
            <Button variant="primary" size="sm" onClick={() => void run()} disabled={picked.length === 0 || busy}>
              {progress ? `Reading… ${progress.done} of ${progress.total} done` : `Read ${billGroups.length} bill(s)`}
            </Button>
          </div>
          {progress && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
              {READ_AT_ONCE} bills with the reader at a time — each shows below as it is read. Opening waits until every bill is read.
            </div>
          )}

          {picked.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {picked.map((p) => (
                <div key={p.rid} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-13)' }}>
                  <input type="checkbox" aria-label={`Select ${p.file.name}`}
                    checked={ticked.has(p.rid)}
                    onChange={(e) => setTicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.rid); else n.delete(p.rid); return n; })}
                    style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }} />
                  <FileText {...ICON} />
                  <span>{p.file.name}</span>
                  {p.merged && <span style={{ fontSize: 'var(--fs-11)', color: 'var(--fg-muted)' }}>(merged page)</span>}
                  <button type="button" aria-label={`Remove ${p.file.name}`} onClick={() => removeFile(p.rid)} disabled={busy}
                    style={{ border: 'none', background: 'none', cursor: busy ? 'default' : 'pointer', color: 'var(--fg-muted)' }}>
                    <X size={14} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {note && <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>{note}</div>}
          {!progress && failedCount > 0 && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>
              {failedCount} bill(s) could not be read — each says why below; Read again tries just that one.
            </div>
          )}
        </div>
      </section>

      {results && (
        <>
          {!ap && okBills.length > 1 && (
            <section className={styles.card}>
              <div className={styles.cardBody} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
                <span style={{ color: 'var(--fg-muted)' }}>Different receipts on ONE voucher (petty cash): tick them below, then</span>
                <Button variant="primary" size="sm" onClick={openTickedAsOne} disabled={busy || tickedBills.length < 2 || tickedCurrencies.size > 1}>
                  Open ticked as ONE voucher ({tickedBills.length} lines)
                </Button>
                {tickedCurrencies.size > 1
                  ? <span style={{ color: 'var(--c-festive-b, #B8331F)' }}>the ticked receipts are in different currencies</span>
                  : <span style={{ color: 'var(--fg-muted)' }}>· one line per receipt, the payee left for you, every page attached</span>}
              </div>
            </section>
          )}
          {groups.map((g) => {
            /* An AP invoice is one per bill by nature — a group never merges. */
            const split = ap || splitGroups.has(g.key) || g.bills.length === 1;
            return (
              <section key={g.key} className={styles.card}>
                <div className={styles.cardHeader}>
                  <h2 className={styles.cardTitle}>{g.label}</h2>
                  <span style={{ fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' }}>
                    {g.bills.length} bill(s) · {fmtRm(g.bills.reduce((s, b) => s + (b.extraction.totalSen ?? 0), 0))}
                    {g.supplierId ? ' · matched supplier' : ' · no supplier match'}
                    {g.bills[0]?.memory?.debitAccountCode ? ` · account remembered (${g.bills[0].memory.debitAccountCode})` : ''}
                  </span>
                </div>
                <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  {/* 多可以，但要整齐 (the owner, 2026-09-02): one aligned grid
                      per bill — number / dates / total on a fixed template, the
                      bill's own line items as a two-column table under it. */}
                  {g.bills.map((b) => (
                    <div key={b.index} style={{ border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 8, padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: `${ap ? '' : '18px '}minmax(120px, 180px) 100px 130px 1fr auto`, gap: 'var(--space-3)', alignItems: 'center', fontSize: 'var(--fs-13)' }}>
                        {!ap && (
                          <input type="checkbox" aria-label={`Tick ${b.extraction.invoiceNumber ?? `bill ${b.index + 1}`} for one voucher`}
                            checked={tickedForOne.has(b.index)}
                            onChange={(e) => setTickedForOne((prev) => { const n = new Set(prev); if (e.target.checked) n.add(b.index); else n.delete(b.index); return n; })}
                            style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }} />
                        )}
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{b.extraction.invoiceNumber ?? '(no number)'}</span>
                        <span style={{ color: 'var(--fg-muted)' }}>{fmtDate(b.extraction.invoiceDate)}</span>
                        <span style={{ color: 'var(--fg-muted)' }}>{b.extraction.dueDate ? `due ${fmtDate(b.extraction.dueDate)}` : ''}</span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(b.extraction.totalSen)}</span>
                        {ap ? (
                          <Button variant="primary" size="sm" onClick={() => openApInvoice(b)} disabled={busy}>
                            Open as AP invoice
                          </Button>
                        ) : split ? (
                          <span style={{ display: 'inline-flex', gap: 6 }}>
                            <Button variant="secondary" size="sm" disabled={busy} onClick={() => openVoucher(b.extraction, { memory: b.memory, files: billFiles[b.index] ?? [], eventSuggestions: b.eventSuggestions ?? [] })}>
                              Open as voucher
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openBill(b.extraction, g.supplierId)} disabled={busy}>
                              Open as bill
                            </Button>
                          </span>
                        ) : <span />}
                      </div>
                      {(b.extraction.totalSen == null || b.extraction.sstSen != null || b.extraction.vendorRegNo) && (
                        <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--fs-12)', color: 'var(--fg-muted)', flexWrap: 'wrap' }}>
                          {b.extraction.vendorRegNo && <span>Reg. no {b.extraction.vendorRegNo}</span>}
                          {b.extraction.sstSen != null && <span>SST {fmtRm(b.extraction.sstSen)}</span>}
                          {b.extraction.totalSen == null && <span style={{ color: 'var(--c-festive-b, #B8331F)' }}>total unreadable — will need typing</span>}
                        </div>
                      )}
                      {b.extraction.lines.length > 0 && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', rowGap: 2, columnGap: 'var(--space-3)', fontSize: 'var(--fs-12)', borderTop: '1px dashed var(--border-weak, #e3e1da)', paddingTop: 6 }}>
                          {b.extraction.lines.map((l, i) => (
                            <div key={i} style={{ display: 'contents' }}>
                              <span style={{ color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description ?? '—'}</span>
                              <span style={{ fontFamily: 'var(--font-mono)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtRm(l.amountSen)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <PileBillMatches no={b.extraction.invoiceNumber} date={b.extraction.invoiceDate} />
                    </div>
                  ))}
                  {!ap && g.bills.length > 1 && (
                    <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
                      <label style={{ fontSize: 'var(--fs-12)', display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked={split}
                          aria-label={`Pay ${g.label} bills separately`}
                          onChange={(e) => setSplitGroups((prev) => { const n = new Set(prev); if (e.target.checked) n.add(g.key); else n.delete(g.key); return n; })}
                          style={{ width: 15, height: 15, accentColor: 'var(--c-orange)' }} />
                        pay each bill separately
                      </label>
                      {!split && (<>
                        <Button variant="primary" size="sm" onClick={() => openGroupAsOne(g)} disabled={busy}>
                          Open as ONE voucher ({g.bills.length} lines)
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
                          const first = g.bills[0]!;
                          openBill(
                            { ...first.extraction, invoiceNumber: g.bills.map((b) => b.extraction.invoiceNumber).filter(Boolean).join(', ') || null },
                            g.supplierId,
                            g.bills.map((b) => ({
                              description: [g.label, b.extraction.invoiceNumber].filter(Boolean).join(' '),
                              amountSen: b.extraction.totalSen,
                            })),
                          );
                        }}>
                          Open as ONE bill
                        </Button>
                      </>)}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
          {results.filter((b) => !b.ok).map((b) => (
            <section key={`fail-${b.index}`} className={styles.card}>
              <div className={styles.cardBody} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)' }}>
                <span style={{ color: 'var(--c-festive-b, #B8331F)', flex: 1, minWidth: 0 }}>
                  Bill {b.index + 1}{namesOf(b.index) ? ` (${namesOf(b.index)})` : ''} could not be read: {(b as { reason: string }).reason}
                </span>
                <Button variant="secondary" size="sm" onClick={() => void readAgain(b.index)} disabled={busy}>
                  {rereading.has(b.index) ? 'Reading…' : 'Read again'}
                </Button>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
};
