/* ------------------------------------------------------------------------- *
 * MobilePaymentRequests — 申请付款 on the phone (owner 2026-09-29/30: Event 的
 * rental 要还的要相关负责人 upload，然后我 finance 这里负责做 payment).
 *
 * The person asking is usually a PIC at a fair with the organiser's invoice in
 * hand, so the phone is where the request starts: who to pay, how much, by
 * when, the event, what for, the payee's bank, and a PHOTO of the bill. They
 * watch it move — Submitted → Finance processing → Paid → Bank confirmed — edit
 * or withdraw it while it waits, and fix and resend one Finance returned.
 *
 * IT OWNS NO RULES. Every read and write is the desktop page's own hook
 * (vendor/scm/lib/payment-request-queries.ts), the stage words are its STAGE
 * table, and the stage itself is the SERVER's reading of the document that
 * answered it. Finance answers a request on the computer — a voucher (PV New
 * ?fromRequest=) or an AP invoice (AP Invoices ?fromRequest=); on the phone
 * Finance can read requests and return one with its note.
 *
 * Gate: the menu row points at /scm/payment-requests, whose NAV_TABS entries
 * (Sidebar.tsx — the requester's key, or Finance's voucher key) MobileApp's
 * allowed() resolves, so phone and desktop are gated by one declaration.
 * ------------------------------------------------------------------------- */

import { useMemo, useRef, useState } from "react";
import {
  NO_EVENT_REASON_MIN, STAGE, answerText, awaitsFinance, fetchPaymentRequestFileBlobUrl, financeWorking, hasInstalments, mayAskBalance, pctOf, requestPaid, useCreatePaymentRequest, useDeletePaymentRequestFile,
  usePaymentRequest, usePaymentRequestFiles, usePaymentRequests, useRequestBalance, useReturnPaymentRequest, useUpdatePaymentRequest,
  useUploadPaymentRequestFile, useWithdrawPaymentRequest,
  type PaymentRequest, type PaymentRequestInput,
} from "../vendor/scm/lib/payment-request-queries";
import { billFactsOf, needsEvent, useRequestBillRead } from "../vendor/scm/lib/request-bill-read";
import { BillInstalments, BillMatchesNote, BillReadNote, billFactsLine } from "../vendor/scm/components/RequestBill";
import { OfficialDocChip } from "../vendor/scm/components/OfficialDoc";
import { useUploadOfficialDoc } from "../vendor/scm/lib/official-doc-queries";
import { EventSuggestions } from "../vendor/scm/components/EventSuggestions";
import { fileToBase64, PV_FILE_ACCEPT } from "../vendor/scm/lib/payment-voucher-queries";
import { useEventLabels } from "../vendor/scm/lib/event-queries";
import { EventSelect, eventCellText } from "../vendor/scm/components/EventSelect";
import { MoneyInput } from "../vendor/scm/components/MoneyInput";
import { DateField } from "../vendor/scm/components/DateField";
import { useConfirm, usePrompt } from "../vendor/scm/components/ConfirmDialog";
import { useAuth } from "../auth/AuthContext";
import { fmtDateOrDash, fmtSen } from "../vendor/shared/format";

const EVENTS_PATH = "/payment-requests/event-options" as const;
type View = { t: "list" } | { t: "new" } | { t: "edit"; req: PaymentRequest } | { t: "detail"; id: string } | { t: "balance"; req: PaymentRequest };
type Filter = "all" | "waiting" | "paid" | "returned" | "official";

export function MobilePaymentRequests({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View>({ t: "list" });
  if (view.t === "new") return <RequestFormScreen initial={null} onBack={() => setView({ t: "list" })} onDone={(id) => setView({ t: "detail", id })} />;
  if (view.t === "edit") return <RequestFormScreen initial={view.req} onBack={() => setView({ t: "detail", id: view.req.id })} onDone={(id) => setView({ t: "detail", id })} />;
  if (view.t === "balance") return <BalanceScreen request={view.req} onBack={() => setView({ t: "detail", id: view.req.id })} onDone={(id) => setView({ t: "detail", id })} />;
  if (view.t === "detail") return <RequestDetailScreen id={view.id} onBack={() => setView({ t: "list" })} onEdit={(req) => setView({ t: "edit", req })} onBalance={(req) => setView({ t: "balance", req })} />;
  return <RequestListScreen onBack={onBack} onNew={() => setView({ t: "new" })} onOpen={(id) => setView({ t: "detail", id })} />;
}

function Shell({ eyebrow, title, onBack, footer, children }: { eyebrow: string; title: string; onBack: () => void; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="hz-m" style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--app-bg)" }}>
      <header className="hdr">
        <div className="hdr-row">
          <button className="back" onClick={onBack}><span className="chev">‹</span> Back</button>
          <span className="eyebrow">{eyebrow}</span>
        </div>
        <div className="hdr-row" style={{ marginTop: 2 }}>
          <div className="scr-title">{title}</div>
        </div>
      </header>
      <div className="hz-scroll" style={{ flex: 1, overflowY: "auto", padding: 14, paddingBottom: 40, display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
      {footer && <div className="actbar" style={{ display: "flex", gap: 10 }}>{footer}</div>}
    </div>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => (
  <div style={{ padding: "18px 4px", fontSize: 12.5, color: "var(--mut)", textAlign: "center" }}>{children}</div>
);
const StageText = ({ r }: { r: PaymentRequest }) => (
  <span style={{ fontSize: 11.5, fontWeight: 600, color: STAGE[r.stage].tone }}>{STAGE[r.stage].label}</span>
);

/* ── The list ─────────────────────────────────────────────────────────────── */
function RequestListScreen({ onBack, onNew, onOpen }: { onBack: () => void; onNew: () => void; onOpen: (id: string) => void }) {
  const q = usePaymentRequests(false);
  const rows = useMemo(() => q.data?.requests ?? [], [q.data]);
  const finance = q.data?.finance ?? false;
  const labels = useEventLabels(rows.map((r) => r.project_id), EVENTS_PATH);
  const [filter, setFilter] = useState<Filter>("all");
  const shown = rows.filter((r) =>
    filter === "all" ? true
      : filter === "waiting" ? awaitsFinance(r) || financeWorking(r)
        : filter === "paid" ? requestPaid(r)
          /* 欠正式单 (item 3): still owes the official invoice, or it waits to be checked. */
          : filter === "official" ? r.officialDoc?.state === "OWED" || r.officialDoc?.state === "RECEIVED"
            : r.stage === "RETURNED" || r.stage === "WITHDRAWN");
  const chips: Array<[Filter, string]> = [["all", "All"], ["waiting", "Waiting"], ["paid", "Paid"], ["returned", "Returned"], ["official", "欠正式单"]];

  const body = () => {
    if (q.isLoading) return <Note>Loading requests…</Note>;
    if (q.isError) return <Note>Could not load the requests. Pull down or try again.</Note>;
    if (rows.length === 0) return <Note>{finance ? "No payment request has been raised yet." : "You have not asked Finance to pay anything yet — tap New request."}</Note>;
    if (shown.length === 0) return <Note>No request in this view.</Note>;
    return shown.map((r) => (
      <button key={r.id} type="button" className="so-row" onClick={() => onOpen(r.id)} style={{ textAlign: "left", width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{r.payee_name}</span>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{fmtSen(r.amount_sen)}</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 2 }}>
          {r.request_no} · {fmtDateOrDash(r.created_at)}{finance && r.requested_by_name ? ` · ${r.requested_by_name}` : ""}
        </div>
        <div style={{ fontSize: 11.5, marginTop: 2 }}>{r.purpose}</div>
        {r.project_id != null && <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>{eventCellText(labels.data, r.project_id)}</div>}
        <div style={{ marginTop: 4 }}><StageText r={r} />{answerText(r) ? <span style={{ fontSize: 11, color: "var(--mut)" }}> · {answerText(r)}</span> : null}</div>
        {r.officialDoc && <div style={{ marginTop: 2 }}><OfficialDocChip state={r.officialDoc.state} /></div>}
      </button>
    ));
  };

  return (
    <Shell eyebrow="Payments · 申请付款" title="Payment requests" onBack={onBack}
      footer={<button className="btn" style={{ flex: 1 }} onClick={onNew}>New request</button>}>
      <div className="chips" style={{ flex: "none" }}>
        {chips.map(([k, label]) => (
          <button key={k} className={`chip${filter === k ? " on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {body()}
    </Shell>
  );
}

/* ── One request ──────────────────────────────────────────────────────────── */
function RequestDetailScreen({ id, onBack, onEdit, onBalance }: { id: string; onBack: () => void; onEdit: (r: PaymentRequest) => void; onBalance: (r: PaymentRequest) => void }) {
  const { user } = useAuth();
  const q = usePaymentRequest(id);
  const r = q.data?.request ?? null;
  const finance = q.data?.finance ?? false;
  const labels = useEventLabels(r ? [r.project_id] : [], EVENTS_PATH);
  const files = usePaymentRequestFiles(id);
  const upload = useUploadPaymentRequestFile();
  const remove = useDeletePaymentRequestFile();
  /* 补正式单 (item 3). */
  const official = useUploadOfficialDoc();
  const offRef = useRef<HTMLInputElement>(null);
  const withdraw = useWithdrawPaymentRequest();
  const sendBack = useReturnPaymentRequest();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  if (q.isLoading) return <Shell eyebrow="Payment request" title="…" onBack={onBack}><Note>Loading…</Note></Shell>;
  if (!r) return <Shell eyebrow="Payment request" title="Not found" onBack={onBack}><Note>This request could not be opened.</Note></Shell>;

  const mine = Number(r.requested_by) === Number(user?.id);
  const mayChange = mine && (r.status === "SUBMITTED" || r.status === "REJECTED");
  const mayAttach = (mine || finance) && r.status !== "WITHDRAWN" && r.status !== "VOUCHERED";
  /* 申请付余额 (item 2): the next instalment of the same bill. */
  const mayBalance = (mine || finance) && mayAskBalance(r);

  const addFiles = async (list: FileList | null) => {
    setFileError(null);
    for (const f of [...(list ?? [])]) {
      try {
        await upload.mutateAsync({ id: r.id, file: { name: f.name, mime: f.type || "application/pdf", dataBase64: await fileToBase64(f) } });
      } catch (e) {
        setFileError(`${f.name} did not attach — ${e instanceof Error ? e.message : "try again"}.`);
        break;
      }
    }
  };
  const sendOfficial = async (list: FileList | null) => {
    setFileError(null);
    for (const f of [...(list ?? [])]) {
      try {
        await official.mutateAsync({ requestId: r.id, file: { name: f.name, mime: f.type || "application/pdf", dataBase64: await fileToBase64(f) } });
      } catch (e) {
        setFileError(`${f.name} did not upload — ${e instanceof Error ? e.message : "try again"}.`);
        break;
      }
    }
  };
  const view = async (fileId: string) => {
    try {
      const { url } = await fetchPaymentRequestFileBlobUrl(r.id, fileId);
      window.open(url, "_blank", "noopener");
      setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : "The file could not be opened.");
    }
  };
  const onWithdraw = async () => {
    if (await askConfirm({ title: `Withdraw ${r.request_no}?`, body: "Finance will not pay it.", confirmLabel: "Withdraw", danger: true })) withdraw.mutate(r.id);
  };
  const onReturn = async () => {
    const note = await askPrompt({ title: `Return ${r.request_no}?`, body: "The requester reads your note and sends it again.", confirmLabel: "Send back", input: { label: "Why it goes back", required: true } });
    if (note) sendBack.mutate({ id: r.id, note });
  };

  const row = (label: string, value: React.ReactNode) => (
    <div className="st-fld" style={{ flex: "none" }}>
      <span className="st-fl">{label}</span>
      <div style={{ fontSize: 13 }}>{value}</div>
    </div>
  );

  return (
    <Shell eyebrow={`Payment request · ${r.request_no}`} title={r.payee_name} onBack={onBack}
      footer={(mayChange || mayBalance || (finance && awaitsFinance(r))) ? (
        <>
          {mayChange && <button className="btn" style={{ flex: 1 }} onClick={() => onEdit(r)}>{r.status === "REJECTED" ? "Fix and send again" : "Edit"}</button>}
          {mayChange && <button className="btn" style={{ flex: 1, background: "var(--bg)", color: "var(--ink)" }} onClick={() => void onWithdraw()} disabled={withdraw.isPending}>Withdraw</button>}
          {!mayChange && finance && awaitsFinance(r) && <button className="btn" style={{ flex: 1 }} onClick={() => void onReturn()} disabled={sendBack.isPending}>Return…</button>}
          {!mayChange && mayBalance && <button className="btn" style={{ flex: 1 }} onClick={() => onBalance(r)}>申请付余额 · Balance</button>}
        </>
      ) : undefined}>
      <div><StageText r={r} /></div>
      {r.stage === "RETURNED" && r.finance_note && (
        <div className="st-warn" role="status">Returned by {r.decided_by ?? "Finance"}: {r.finance_note}</div>
      )}
      {finance && awaitsFinance(r) && (
        <div style={{ fontSize: 11.5, color: "var(--mut)" }}>Answer it on the computer — Payment Requests › Make voucher or Make AP invoice.</div>
      )}
      {row("Amount", <b>{fmtSen(r.amount_sen)}</b>)}
      {row("Pay by", fmtDateOrDash(r.due_date))}
      {row("Event", eventCellText(labels.data, r.project_id))}
      {row("For", r.purpose)}
      {row("The bill", r.bill_no || r.bill_date || r.bill_total_sen != null ? billFactsLine({ billNo: r.bill_no, billDate: r.bill_date, totalSen: r.bill_total_sen }) : "— not read")}
      {r.project_id == null && r.no_event_reason && row("No event — why", r.no_event_reason)}
      {hasInstalments(r.family) && <BillInstalments family={r.family} currentId={r.id} />}
      {mayChange && mayBalance && (
        <button type="button" className="btn" style={{ background: "var(--bg)", color: "var(--ink)" }} onClick={() => onBalance(r)}>申请付余额 · Request the balance</button>
      )}
      <BillMatchesNote matches={r.billMatches} />
      {/* 欠正式单 (item 3): paid on a proforma — the official invoice is uploaded here, Finance checks it. */}
      {r.officialDoc && (
        <div role="group" aria-label="Official invoice" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", background: "#fff", borderRadius: 10 }}>
          <OfficialDocChip state={r.officialDoc.state} note={r.officialDoc.note} />
          {r.officialDoc.note && <div style={{ fontSize: 12, color: "var(--mut)" }}>{r.officialDoc.note}</div>}
          {(mine || finance) && (r.officialDoc.state === "OWED" || r.officialDoc.state === "RECEIVED") && (
            <>
              <input ref={offRef} type="file" accept={PV_FILE_ACCEPT} style={{ display: "none" }} aria-label="Upload the official invoice"
                onChange={(e) => { void sendOfficial(e.target.files); e.target.value = ""; }} />
              <button type="button" className="btn" onClick={() => offRef.current?.click()} disabled={official.isPending}>补正式单 · Upload the official invoice</button>
            </>
          )}
        </div>
      )}
      {row("Payee's bank", [r.bank_name, r.bank_account_no, r.bank_account_name].filter(Boolean).join(" · ") || "—")}
      {row("Requested by", `${r.requested_by_name ?? "—"} · ${fmtDateOrDash(r.created_at)}`)}
      {r.voucher && row("Voucher", `${r.voucher.pvNumber ?? "Draft"}${r.voucher.postedAt ? ` · paid ${fmtDateOrDash(r.voucher.approvedAt ?? r.voucher.postedAt)}` : ""}${r.voucher.bankConfirmed ? " · bank ✓" : ""}`)}
      {r.invoice && row("AP invoice", `${answerText(r) ?? ""}${r.invoice.bankConfirmed ? " · bank ✓" : ""}`)}

      <div className="sc-sl"><span className="t">The bill</span><span className="ln" /></div>
      {fileError && <div className="st-warn" role="alert">{fileError}</div>}
      {(files.data?.files ?? []).length === 0 && (
        <Note>{r.parent_request_id ? `The bill is on ${r.family?.rootNo ?? "the first request"} — nothing to upload again.` : "No bill attached yet."}</Note>
      )}
      {(files.data?.files ?? []).map((f) => (
        <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#fff", borderRadius: 10, fontSize: 12.5 }}>
          <button type="button" onClick={() => void view(f.id)} style={{ flex: 1, textAlign: "left", border: "none", background: "none", color: "var(--brand-d)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.file_name}</button>
          {/* 申请一定要有: the last file stays — attach the right one first. */}
          {mayAttach && (files.data?.files ?? []).length > 1 && (
            <button type="button" onClick={() => remove.mutate({ id: r.id, fileId: f.id })} disabled={remove.isPending}
              style={{ border: "none", background: "none", color: "#a33", fontSize: 12 }}>Remove</button>
          )}
        </div>
      ))}
      {mayAttach && (
        <div style={{ display: "flex", gap: 8 }}>
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} aria-label="Take a photo of the bill"
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <input ref={libRef} type="file" accept={PV_FILE_ACCEPT} multiple style={{ display: "none" }} aria-label="Pick bill files"
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <button className="btn" style={{ flex: 1 }} onClick={() => camRef.current?.click()} disabled={upload.isPending}>📷 Photo</button>
          <button className="btn" style={{ flex: 1, background: "var(--bg)", color: "var(--ink)" }} onClick={() => libRef.current?.click()} disabled={upload.isPending}>Pick file</button>
        </div>
      )}
    </Shell>
  );
}

/* ── New / edit ───────────────────────────────────────────────────────────── */
function RequestFormScreen({ initial, onBack, onDone }: { initial: PaymentRequest | null; onBack: () => void; onDone: (id: string) => void }) {
  const create = useCreatePaymentRequest();
  const update = useUpdatePaymentRequest();
  const upload = useUploadPaymentRequestFile();
  /* Whether the company runs events (2990 does not) — the list's own answer. */
  const hasEvents = usePaymentRequests(false).data?.hasEvents ?? true;
  const camRef = useRef<HTMLInputElement>(null);
  const libRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState<PaymentRequestInput>(() => ({
    payeeName: initial?.payee_name ?? "",
    amountSen: initial?.amount_sen ?? 0,
    dueDate: initial?.due_date ?? null,
    purpose: initial?.purpose ?? "",
    projectId: initial?.project_id ?? null,
    bankName: initial?.bank_name ?? null,
    bankAccountNo: initial?.bank_account_no ?? null,
    bankAccountName: initial?.bank_account_name ?? null,
  }));
  /* The bill is READ as it is attached (owner 2026-10-01, item 1). */
  const billRead = useRequestBillRead();
  const [noEvent, setNoEvent] = useState(() => !!initial?.no_event_reason);
  const [noEventReason, setNoEventReason] = useState(initial?.no_event_reason ?? "");
  const set = (patch: Partial<PaymentRequestInput>) => setV((prev) => ({ ...prev, ...patch }));
  /* 一张单付两次 (item 2): the bill's total, and this payment as a percent of it. */
  const isBalance = !!initial?.parent_request_id;
  const [billTotal, setBillTotal] = useState<number | null>(initial?.bill_total_sen ?? null);
  const [pct, setPct] = useState<string>(initial?.pay_pct != null ? String(initial.pay_pct) : "");
  const pctValue = (() => { const n = Number(pct); return pct.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; })();
  const applyPct = (raw: string, total: number | null) => {
    setPct(raw);
    const n = Number(raw);
    if (total != null && total > 0 && raw.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 100) set({ amountSen: pctOf(total, n) });
  };
  const takeFiles = async (list: File[]) => {
    setFiles(list);
    const read = await billRead.run(list);
    const readTotal = read?.bill.totalSen ?? null;
    if (readTotal != null && readTotal > 0) setBillTotal((prev) => prev ?? readTotal);
    const top = read?.eventBill ? read.eventSuggestions[0] : undefined;
    if (top) setV((prev) => (prev.projectId == null ? { ...prev, projectId: top.id } : prev));
  };
  const eventNeeded = hasEvents && (needsEvent(billRead.state) || !!initial?.event_bill);
  const eventOk = !eventNeeded || v.projectId != null || (noEvent && noEventReason.trim().length >= NO_EVENT_REASON_MIN);
  const reading = billRead.state.status === "reading";
  const missing = [
    v.payeeName.trim() === "" ? "who to pay" : null,
    v.amountSen > 0 ? null : "the amount",
    v.purpose.trim() === "" ? "what it is for" : null,
    !initial && files.length === 0 ? "a photo of the bill" : null,
    eventOk ? null : "the event (or why there is none)",
  ].filter(Boolean) as string[];
  const ready = missing.length === 0 && !reading;
  const busy = create.isPending || update.isPending || upload.isPending;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  const save = async () => {
    setError(null);
    if (!ready) { setError(reading ? "The bill is still being read — a moment." : `Still needed: ${missing.join(", ")}.`); return; }
    const body: PaymentRequestInput = {
      ...v,
      ...billFactsOf(billRead.state),
      noEventReason: v.projectId == null && noEvent ? noEventReason.trim() : null,
      ...(isBalance ? {} : { billTotalSen: billTotal }),
      payPct: pctValue != null && billTotal != null && pctOf(billTotal, pctValue) === v.amountSen ? pctValue : null,
    };
    try {
      const res = initial ? await update.mutateAsync({ id: initial.id, ...body }) : await create.mutateAsync(body);
      for (const f of files) {
        try {
          await upload.mutateAsync({ id: res.request.id, file: { name: f.name, mime: f.type || "application/pdf", dataBase64: await fileToBase64(f) } });
        } catch {
          /* The request stands; the detail screen says the bill is missing and takes it again. */
          break;
        }
      }
      onDone(res.request.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request was not sent.");
    }
  };

  const field = (label: string, control: React.ReactNode) => (
    <div className="st-fld" style={{ flex: "none" }}>
      <span className="st-fl">{label}</span>
      {control}
    </div>
  );

  return (
    <Shell eyebrow="Payments · 申请付款" title={initial ? `Edit ${initial.request_no}` : "New payment request"} onBack={onBack}
      footer={<button className="btn" style={{ flex: 1, opacity: busy || !ready ? 0.5 : 1 }} disabled={busy || reading} onClick={() => void save()}>
        {busy ? "Sending…" : reading ? "Reading the bill…" : initial ? (initial.status === "REJECTED" ? "Send again" : "Save") : "Send to Finance"}
      </button>}>
      {initial?.status === "REJECTED" && initial.finance_note && <div className="st-warn" role="status">Finance returned it: {initial.finance_note}</div>}
      {error && <div className="st-warn" role="alert">{error}</div>}
      {!initial && (
        <>
          <div className="sc-sl"><span className="t">The bill *</span><span className="ln" /></div>
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} aria-label="Take a photo of the bill"
            onChange={(e) => { void takeFiles([...files, ...(e.target.files ?? [])]); e.target.value = ""; }} />
          <input ref={libRef} type="file" accept={PV_FILE_ACCEPT} multiple style={{ display: "none" }} aria-label="Pick bill files"
            onChange={(e) => { void takeFiles([...files, ...(e.target.files ?? [])]); e.target.value = ""; }} />
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "#fff", borderRadius: 10, fontSize: 12.5 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              <button type="button" onClick={() => void takeFiles(files.filter((_, k) => k !== i))} style={{ border: "none", background: "none", color: "#a33", fontSize: 12 }}>Remove</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => camRef.current?.click()}>📷 Photo</button>
            <button type="button" className="btn" style={{ flex: 1, background: "var(--bg)", color: "var(--ink)" }} onClick={() => libRef.current?.click()}>Pick file</button>
          </div>
          <BillReadNote state={billRead.state} />
        </>
      )}
      {field("Pay to *", <input className="cal-sel" aria-label="Pay to" value={v.payeeName} onChange={(e) => set({ payeeName: e.target.value })} placeholder="e.g. MLE EVENTS SDN BHD" />)}
      {!isBalance && field("The bill's total (MYR)", <MoneyInput bare valueSen={billTotal ?? 0} inputClassName="cal-sel" selectOnFocus aria-label="Bill total"
        onCommit={(sen) => { const t = sen != null && sen > 0 ? sen : null; setBillTotal(t); if (pct) applyPct(pct, t); }} />)}
      {field("Amount to pay now (MYR) *", <MoneyInput bare valueSen={v.amountSen} onCommit={(sen) => set({ amountSen: sen ?? 0 })} inputClassName="cal-sel" selectOnFocus aria-label="Amount" />)}
      {billTotal != null && field("…or a percent of the bill", <input className="cal-sel" inputMode="decimal" aria-label="Percent of the bill" value={pct} placeholder="e.g. 50" onChange={(e) => applyPct(e.target.value, billTotal)} />)}
      {field("Pay by", <DateField fullWidth className="cal-sel" aria-label="Pay by" value={v.dueDate ?? ""} onChange={(iso) => set({ dueDate: iso || null })} />)}
      {hasEvents && field(eventNeeded ? "Event * — this bill is for an event" : "Event", <EventSelect value={v.projectId} around={v.dueDate || today} optionsPath={EVENTS_PATH} className="cal-sel" aria-label="Event" onChange={(id) => set({ projectId: id })} />)}
      {eventNeeded && billRead.state.status === "done" && (
        <EventSuggestions suggestions={billRead.state.result.eventSuggestions} current={v.projectId} onUse={(id) => set({ projectId: id })} />
      )}
      {eventNeeded && v.projectId == null && (
        <>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <input type="checkbox" checked={noEvent} onChange={(e) => setNoEvent(e.target.checked)} aria-label="I cannot find this event" />
            I cannot find this event · 找不到这场活动
          </label>
          {noEvent && field("Why there is no event *", <input className="cal-sel" aria-label="Why there is no event" value={noEventReason} onChange={(e) => setNoEventReason(e.target.value)} placeholder="e.g. the fair is not in PMS yet" />)}
        </>
      )}
      {field("What is it for *", <textarea className="cal-sel" rows={2} aria-label="What is it for" value={v.purpose} onChange={(e) => set({ purpose: e.target.value })} placeholder="e.g. Booth F1 rental, balance 50%" />)}
      <div className="sc-sl"><span className="t">Payee's bank</span><span className="ln" /></div>
      {field("Bank", <input className="cal-sel" aria-label="Payee's bank" value={v.bankName ?? ""} onChange={(e) => set({ bankName: e.target.value || null })} placeholder="e.g. Maybank" />)}
      {field("Account no.", <input className="cal-sel" aria-label="Account no." inputMode="numeric" value={v.bankAccountNo ?? ""} onChange={(e) => set({ bankAccountNo: e.target.value || null })} />)}
      {field("Account name", <input className="cal-sel" aria-label="Account name" value={v.bankAccountName ?? ""} onChange={(e) => set({ bankAccountName: e.target.value || null })} />)}
    </Shell>
  );
}

/* ── 申请付余额 — the next instalment of the same bill (item 2) ─────────────────
   No second upload: the bill is on the first request. The amount starts at what
   is left to ask; the official invoice may come along. */
function BalanceScreen({ request, onBack, onDone }: { request: PaymentRequest; onBack: () => void; onDone: (id: string) => void }) {
  const balance = useRequestBalance();
  const upload = useUploadPaymentRequestFile();
  const camRef = useRef<HTMLInputElement>(null);
  const fam = request.family;
  const total = fam?.totalSen ?? null;
  const left = fam?.remainingSen ?? null;
  const [amount, setAmount] = useState<number>(left ?? 0);
  const [pct, setPct] = useState("");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [purpose, setPurpose] = useState(`Balance — ${request.purpose.replace(/^Balance — /, "")}`);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const busy = balance.isPending || upload.isPending;
  const pctValue = (() => { const n = Number(pct); return pct.trim() !== "" && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; })();

  const save = async () => {
    setError(null);
    if (amount <= 0) { setError("Say how much this instalment is."); return; }
    try {
      const res = await balance.mutateAsync({
        id: request.id, amountSen: amount, dueDate, purpose: purpose.trim() || null,
        payPct: pctValue != null && total != null && pctOf(total, pctValue) === amount ? pctValue : null,
      });
      for (const f of files) {
        try {
          await upload.mutateAsync({ id: res.request.id, file: { name: f.name, mime: f.type || "application/pdf", dataBase64: await fileToBase64(f) } });
        } catch { break; }
      }
      onDone(res.request.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The balance was not requested.");
    }
  };

  const field = (label: string, control: React.ReactNode) => (
    <div className="st-fld" style={{ flex: "none" }}>
      <span className="st-fl">{label}</span>
      {control}
    </div>
  );
  return (
    <Shell eyebrow={`申请付余额 · ${fam?.rootNo ?? request.request_no}`} title="Request the balance" onBack={onBack}
      footer={<button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => void save()}>{busy ? "Sending…" : "Send to Finance"}</button>}>
      {error && <div className="st-warn" role="alert">{error}</div>}
      {fam && hasInstalments(fam) && <BillInstalments family={fam} currentId={request.id} />}
      <div style={{ fontSize: 12, color: "var(--mut)" }}>
        {left != null ? `Left to ask: ${fmtSen(left)}${total != null ? ` of ${fmtSen(total)}` : ""}.` : "The bill's total is not known — type this instalment's amount."} The bill is already on {fam?.rootNo ?? request.request_no} — nothing to upload again.
      </div>
      {field("Amount (MYR) *", <MoneyInput bare valueSen={amount} onCommit={(sen) => { setAmount(sen ?? 0); setPct(""); }} inputClassName="cal-sel" selectOnFocus aria-label="Balance amount" />)}
      {total != null && field("…or a percent of the bill", <input className="cal-sel" inputMode="decimal" aria-label="Balance percent" value={pct} placeholder="e.g. 50"
        onChange={(e) => { setPct(e.target.value); const n = Number(e.target.value); if (Number.isFinite(n) && n > 0 && n <= 100) setAmount(pctOf(total, n)); }} />)}
      {left != null && amount > left && <div className="st-warn" role="alert">More than is left to ask ({fmtSen(left)}) — it still goes, and Finance sees it.</div>}
      {field("Pay by", <DateField fullWidth className="cal-sel" aria-label="Balance pay by" value={dueDate ?? ""} onChange={(iso) => setDueDate(iso || null)} />)}
      {field("What is it for", <input className="cal-sel" aria-label="Balance purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />)}
      <div className="sc-sl"><span className="t">The official invoice (optional)</span><span className="ln" /></div>
      <input ref={camRef} type="file" accept={PV_FILE_ACCEPT} multiple style={{ display: "none" }} aria-label="Official invoice files"
        onChange={(e) => { setFiles([...files, ...(e.target.files ?? [])]); e.target.value = ""; }} />
      {files.map((f, i) => <div key={`${f.name}-${i}`} style={{ fontSize: 12.5 }}>{f.name}</div>)}
      <button type="button" className="btn" style={{ background: "var(--bg)", color: "var(--ink)" }} onClick={() => camRef.current?.click()}>Attach the official invoice</button>
    </Shell>
  );
}

export default MobilePaymentRequests;
