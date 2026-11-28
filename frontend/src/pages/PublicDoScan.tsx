// ----------------------------------------------------------------------------
// PublicDoScan — the delivery-order scan page with NO LOGIN behind it.
//
//   /d/<token>
//
// THE OWNER'S DECISION: 「就跟hookka一样」 — the driver scans the paper with a
// normal phone camera and the page opens. There is no sign-in, and the 64-hex
// token printed on that paper is the only credential. He accepted one addition,
// a kill switch for a leaked link; a killed token gets the SAME "unknown or
// expired" screen an unknown one gets, so the page can never tell a stranger
// that the code he is holding used to be real.
//
// THE SAME THREE SCANS AS THE LOGGED-IN PAGE, FROM THE SAME LADDER. DoLoadScan
// (/scm/do-load) is the authenticated twin. Neither page owns any status logic:
// the rungs, the button words, the line under the button and the confirmation
// sentence all come from vendor/shared/do-scan-ladder.ts, which is the byte-
// identical mirror of the backend's copy. There is ONE ladder declaration in
// this system and both surfaces render it.
//
// WHAT THIS PAGE DELIBERATELY DOES NOT SHOW: any price, the street address, the
// postcode, any phone number or email. Delivery order number, customer name,
// delivery area, line count and status — that is the whole payload, enforced
// server-side and pinned by a test that fails CI if the route file so much as
// mentions a banned column.
//
// AND IT NAMES WHAT IT DOES NOT COLLECT, BEFORE THE BUTTON IS PRESSED. This is
// now the SIXTH way to close a delivery and the only one with nobody logged in
// behind it, so bugs 0480/0481 apply to it hardest: `Confirm Delivered` writes
// DELIVERED and captures no signature, no photo and no location, and the note
// under the button says exactly that and points at Proof of Delivery. The note
// travels WITH the rung, so a rung cannot be rendered without it.
//
// THE PAGE CANNOT PICK A RUNG. It POSTs the rung it was shown; the server
// recomputes the next rung from the row's own status and refuses anything else.
// A second press of the same button is answered "already done" rather than
// quietly taking the NEXT rung.
//
// THE PACKING LIST IS DIFFERENT (owner, 2026-11-27): its QR says "SCAN WHEN FULLY
// LOADED" and does exactly that. One press marks every confirmed delivery order on
// the lorry Loaded and nothing else; the server decides each drop and the page lists
// what happened to every one under a "Lorry X: n of m loaded" headline.
// ----------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, PackageCheck, PauseCircle, XCircle } from "lucide-react";
import { statusLabel } from "../../../shared/src/vendor/scm/lib/status-pill";
import { humanHttpMessage } from "../api/client";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from "../lib/requestCorrelation";

type SheetKind = "trip" | "lorry_day" | "region_day";
const isSheet = (kind: string | undefined): kind is SheetKind =>
  kind === "trip" || kind === "lorry_day" || kind === "region_day";

type Member = {
  stopNo: number;
  doNumber: string | null;
  customerName: string | null;
  status: string | null;
  willLoad: boolean;
  note: string;
};

type TripSummary = {
  kind: SheetKind;
  mode: "load_all";
  tripNo: string | null;
  tripDate: string | null;
  lorryPlate: string | null;
  title?: string;
  nextStep?: "prepare" | "load" | "done" | null;
  preparedAtText?: string;
  loadedAtText?: string;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  members: Member[];
};

type PrepareResult = {
  kind: SheetKind;
  mode: "prepare";
  outcome: "DONE" | "ALREADY_DONE";
  headline: string;
  message: string;
  preparedAtText: string;
};

type MemberOutcome = {
  stopNo: number;
  doNumber: string | null;
  customerName: string | null;
  outcome: "DONE" | "ALREADY_DONE" | "PAST" | "BLOCKED" | "MOVED" | "FAILED";
  from: string | null;
  to?: string;
  status: string | null;
  message: string;
};

type RunResult = {
  kind: SheetKind;
  mode: "load_all";
  tripNo: string | null;
  lorryPlate: string | null;
  outcome: "DONE" | "PARTIAL" | "NOTHING";
  to: string;
  headline: string;
  message: string;
  total: number;
  loaded: number;
  moved: number;
  members: MemberOutcome[];
  preparedAtText?: string;
  loadedAtText?: string;
};

type Summary = {
  kind?: "do";
  doNumber: string;
  customerName: string;
  area: string;
  itemCount: number | null;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
};

type AdvanceResult = {
  kind?: "do";
  outcome: "DONE" | "ALREADY_DONE" | "BLOCKED" | "FAILED";
  doNumber: string;
  from: string;
  to?: string;
  message: string;
};

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : "";

const apiBase = () =>
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

export function PublicDoScan() {
  const token = window.location.pathname.split("/")[2] || "";
  const [data, setData] = useState<Summary | TripSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<AdvanceResult | RunResult | PrepareResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await correlatedFetch(
        `${apiBase()}/api/public/do-scan/${encodeURIComponent(token)}`,
      );
      if (!res.ok) {
        throw correlateError(
          new Error(humanHttpMessage(res.status, await res.text().catch(() => ""))),
          requestIdFromResponse(res),
        );
      }
      setData(await consumeCorrelated(res, () => res.json() as Promise<Summary | TripSummary>));
    } catch (e) {
      setError(errorText(e) || "Could not load this delivery order.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError("This link does not carry a delivery order code.");
      return;
    }
    void load();
  }, [token, load]);

  async function advance(to: string, sheetStep: "prepare" | "load" | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await correlatedFetch(
        `${apiBase()}/api/public/do-scan/${encodeURIComponent(token)}/advance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sheetStep ? { step: sheetStep, to } : { to }),
        },
      );
      if (!res.ok) {
        throw correlateError(
          new Error(humanHttpMessage(res.status, await res.text().catch(() => ""))),
          requestIdFromResponse(res),
        );
      }
      setDone(await consumeCorrelated(res, () => res.json() as Promise<AdvanceResult | RunResult | PrepareResult>));
    } catch (e) {
      setError(errorText(e) || "Could not record this step. Try again, or call the office.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Frame>
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-6 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading the delivery order…
        </div>
      </Frame>
    );
  }

  if (!data) {
    const unreachable = /wait a moment|could not reach/i.test(error ?? "");
    return (
      <Frame>
        <Notice tone="warn" title={unreachable ? "Could not reach the system" : "Unknown or expired QR code"}>
          {error ??
            "This code does not match a delivery order. Please ask the office for a freshly printed copy."}
        </Notice>
      </Frame>
    );
  }

  const step = done ? null : data.step;
  const isRun = isSheet(data.kind);
  const run = isRun ? (data as TripSummary) : null;
  const sheetStep = run && (run.nextStep === "prepare" || run.nextStep === "load") ? run.nextStep : null;
  const runTitle = run ? run.title || (run.lorryPlate ? `Lorry ${run.lorryPlate}` : `Packing list ${run.tripNo ?? ""}`) : "";
  const prepared = done && "preparedAtText" in done && done.preparedAtText ? done.preparedAtText : run?.preparedAtText;
  const loaded = done && "loadedAtText" in done && done.loadedAtText ? done.loadedAtText : run?.loadedAtText;

  return (
    <Frame title={isRun ? "Scan packing list" : "Scan delivery order"}>
      {run ? (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
          <div className="text-base font-semibold">{runTitle}</div>
          <div className="text-ink-secondary">
            {run.lorryPlate && run.tripNo ? `${run.tripNo} · ` : ""}
            {run.tripDate ?? "—"} · {run.members.length} delivery order
            {run.members.length === 1 ? "" : "s"}
          </div>
          {run.nextStep !== undefined && run.nextStep !== null && (
            <ul className="mt-2 space-y-0.5 tabular-nums" aria-label="Scan times">
              <li className={prepared ? "font-semibold" : "text-ink-secondary"}>{prepared ? `Prepared at ${prepared}` : "Not prepared yet"}</li>
              <li className={loaded ? "font-semibold" : "text-ink-secondary"}>{loaded ? `Loaded at ${loaded}` : "Not loaded yet"}</li>
            </ul>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
          <div className="font-mono text-base font-semibold">{(data as Summary).doNumber}</div>
          <div>{(data as Summary).customerName || "—"}</div>
          <div className="text-ink-secondary">
            {(data as Summary).area || "—"} ·{" "}
            {(data as Summary).itemCount === null
              ? "line count unavailable"
              : `${(data as Summary).itemCount} line${(data as Summary).itemCount === 1 ? "" : "s"}`}{" "}
            · {statusLabel("do", (data as Summary).status)}
          </div>
        </div>
      )}

      {done && "mode" in done && done.mode === "prepare" && (
        <Notice tone="ok" title={done.headline}>
          {done.message}
        </Notice>
      )}

      {run && !done && run.nextStep === "done" && (
        <Notice tone="ok" title={`${runTitle}: packing list loaded`}>
          Prepared at {run.preparedAtText || "—"}, loaded at {run.loadedAtText || "—"}. Nothing left to scan on this sheet.
        </Notice>
      )}

      {done && isSheet(done.kind) && !("mode" in done && done.mode === "prepare") && (
        <>
          <Notice
            tone={(done as RunResult).outcome === "PARTIAL" ? "warn" : "ok"}
            title={(done as RunResult).headline}
          >
            {(done as RunResult).message || "Done."}
          </Notice>
          <RunList
            rows={(done as RunResult).members.map((m) => ({
              stopNo: m.stopNo,
              doNumber: m.doNumber,
              customerName: m.customerName,
              status: m.status,
              tone: outcomeTone(m.outcome),
              text: m.message,
            }))}
          />
        </>
      )}

      {done && !isSheet(done.kind) && (
        <Notice
          tone={
            (done as AdvanceResult).outcome === "DONE" ||
            (done as AdvanceResult).outcome === "ALREADY_DONE"
              ? "ok"
              : "warn"
          }
          title={(done as AdvanceResult).doNumber}
        >
          {(done as AdvanceResult).message}
        </Notice>
      )}

      {!done && data.blockReason && (
        <Notice tone={data.status === "CANCELLED" ? "warn" : "hold"} title={run ? runTitle : (data as Summary).doNumber}>
          {data.blockReason}
        </Notice>
      )}

      {step && (
        <>
          <button
            type="button"
            disabled={saving}
            onClick={() => void advance(step.status, sheetStep)}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
          >
            <PackageCheck size={18} /> {saving ? "Saving…" : step.label}
          </button>
          <p className="text-xs text-ink-secondary">{step.note}</p>
          {isRun && sheetStep !== "prepare" && (
            <p className="text-xs text-ink-secondary">
              Only confirmed delivery orders are marked Loaded. Drafts, cancelled or held ones, ones on another
              company&apos;s books, and ones already in transit or delivered are left alone and listed back to you.
            </p>
          )}
        </>
      )}

      {run && !done && (
        <RunList
          rows={run.members.map((m) => ({
            stopNo: m.stopNo,
            doNumber: m.doNumber,
            customerName: m.customerName,
            status: m.status,
            tone: m.willLoad ? "ok" : "muted",
            text: m.note,
          }))}
        />
      )}

      {error && (
        <div className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-900 dark:text-red-300">
          {error}
        </div>
      )}

      {!isRun && !data.blockReason && !done && (
        <a href="/d/scan" className="block text-center text-sm underline text-ink-secondary">
          Loading several? Open the scanner
        </a>
      )}
    </Frame>
  );
}

type RowTone = "ok" | "warn" | "muted";

function outcomeTone(o: MemberOutcome["outcome"]): RowTone {
  if (o === "DONE" || o === "ALREADY_DONE") return "ok";
  if (o === "PAST") return "muted";
  return "warn";
}

const ROW_TONE: Record<RowTone, string> = {
  ok: "text-emerald-800 dark:text-emerald-300",
  muted: "text-ink-secondary",
  warn: "text-amber-800 dark:text-amber-300",
};

function RunList({
  rows,
}: {
  rows: Array<{
    stopNo: number;
    doNumber: string | null;
    customerName: string | null;
    status: string | null;
    tone: RowTone;
    text: string;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">
        There is nothing on this packing list yet. Call the office.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-md border border-line bg-surface text-sm">
      {rows.map((r) => (
        <li key={`${r.stopNo}-${r.doNumber ?? "x"}`} className="flex items-start gap-3 px-4 py-3">
          <span className="mt-0.5 shrink-0 font-mono text-xs text-ink-secondary">#{r.stopNo}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-mono font-semibold">{r.doNumber ?? "Not on this run's account"}</span>
              {r.status && <span className="text-xs text-ink-secondary">{statusLabel("do", r.status)}</span>}
            </div>
            {r.customerName && <div className="break-words">{r.customerName}</div>}
            <div className={ROW_TONE[r.tone]}>{r.text}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Frame({ title = "Scan delivery order", children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-ink-muted">Delivery</div>
        <h1 className="text-lg font-semibold">{title}</h1>
      </div>
      {children}
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "ok" | "warn" | "hold";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-md border px-4 py-4 text-sm ${
        tone === "ok"
          ? "border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300"
          : "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300"
      }`}
    >
      {tone === "ok" ? (
        <CheckCircle2 size={20} className="mt-0.5 shrink-0" />
      ) : tone === "hold" ? (
        <PauseCircle size={20} className="mt-0.5 shrink-0" />
      ) : (
        <XCircle size={20} className="mt-0.5 shrink-0" />
      )}
      <div>
        <div className="font-semibold">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}

export default PublicDoScan;
