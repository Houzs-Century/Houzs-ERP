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
// ----------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, PackageCheck, PauseCircle, XCircle } from "lucide-react";
import { statusLabel } from "../vendor/scm/lib/status-pill";
import { PublicDoScanBasket } from "./PublicDoScanBasket";
import { humanHttpMessage } from "../api/client";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from "../lib/requestCorrelation";

type Member = {
  stopNo: number;
  doNumber: string | null;
  status: string | null;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
};

type TripSummary = {
  kind: "trip";
  tripNo: string;
  tripDate: string | null;
  status: string;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  members: Member[];
};

type MemberOutcome = {
  stopNo: number;
  doNumber: string | null;
  outcome: "DONE" | "ALREADY_DONE" | "BLOCKED" | "FAILED";
  from: string | null;
  to?: string;
  message: string;
};

type RunResult = {
  kind: "trip";
  tripNo: string;
  outcome: "DONE" | "PARTIAL" | "NOTHING";
  to: string;
  message: string;
  members: MemberOutcome[];
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

/* A message the DRIVER can read, from whatever was thrown. Never `e as any`:
   the two catch sites below are the only place a server sentence reaches this
   screen, and a typed reader is what stops a stray object rendering as
   "[object Object]" at a lorry. */
const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : "";

const apiBase = () =>
  (import.meta.env.VITE_API_URL as string) ||
  (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");

export function PublicDoScan() {
  /* Read from the LOCATION, not a router param: this surface is chosen before
     any <Routes> exists (main.tsx renders it straight, the way SurveyPublic is
     rendered), so there is no param to read. */
  const token = window.location.pathname.split("/")[2] || "";
  const [data, setData] = useState<Summary | TripSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /* What THIS scan recorded, held here rather than read back off a refetch —
     the same reason DoLoadScan holds it: the confirmation card must stand until
     the paper is scanned again, which is the physical shape of "one scan, one
     step". */
  const [done, setDone] = useState<AdvanceResult | RunResult | null>(null);

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

  async function advance(to: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await correlatedFetch(
        `${apiBase()}/api/public/do-scan/${encodeURIComponent(token)}/advance`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          /* The rung this page was SHOWN. The server recomputes the real one
             and refuses if they differ, so this is an expectation, never an
             instruction. */
          body: JSON.stringify({ to }),
        },
      );
      if (!res.ok) {
        throw correlateError(
          new Error(humanHttpMessage(res.status, await res.text().catch(() => ""))),
          requestIdFromResponse(res),
        );
      }
      setDone(await consumeCorrelated(res, () => res.json() as Promise<AdvanceResult | RunResult>));
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
    /* THE TITLE FOLLOWS THE SERVER'S ANSWER. A 503 means the system could not be
       reached, not that the paper is dead — putting "Unknown or expired" over a
       blip sends a driver back to the office over a hiccup. A REVOKED code
       deliberately lands on the same screen as an unknown one; a blip does not,
       because it says nothing about the code in hand. */
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
  const isRun = data.kind === "trip";

  return (
    <Frame>
      {isRun ? (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
          <div className="font-mono text-base font-semibold">{(data as TripSummary).tripNo}</div>
          <div className="text-ink-secondary">
            {(data as TripSummary).tripDate ?? "—"} ·{" "}
            {(data as TripSummary).members.length} drop
            {(data as TripSummary).members.length === 1 ? "" : "s"} on this run
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
          <div className="font-mono text-base font-semibold">{(data as Summary).doNumber}</div>
          <div>{(data as Summary).customerName || "—"}</div>
          <div className="text-ink-secondary">
            {/* A DASH, NOT "0 lines", when the server could not count them. Zero
                is a claim about the load; a dash says we do not know. */}
            {(data as Summary).area || "—"} ·{" "}
            {(data as Summary).itemCount === null
              ? "line count unavailable"
              : `${(data as Summary).itemCount} line${(data as Summary).itemCount === 1 ? "" : "s"}`}{" "}
            · {statusLabel("do", (data as Summary).status)}
          </div>
        </div>
      )}

      {done && done.kind === "trip" && (
        <>
          <Notice
            tone={(done as RunResult).outcome === "PARTIAL" ? "warn" : "ok"}
            title={(done as RunResult).tripNo}
          >
            {(done as RunResult).message}
          </Notice>
          {/* EVERY DROP GETS A LINE. A driver who is told "3 of 5 recorded" and
              not WHICH two is worse off than one told nothing, because he has to
              re-scan the whole run to find out. */}
          <RunList
            rows={(done as RunResult).members.map((m) => ({
              stopNo: m.stopNo,
              doNumber: m.doNumber,
              tone: m.outcome === "DONE" || m.outcome === "ALREADY_DONE" ? "ok" : "warn",
              text: m.message,
            }))}
          />
        </>
      )}

      {done && done.kind !== "trip" && (
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
        <Notice tone={data.status === "CANCELLED" ? "warn" : "hold"} title={isRun ? (data as TripSummary).tripNo : (data as Summary).doNumber}>
          {data.blockReason}
        </Notice>
      )}

      {step && (
        <>
          <button
            type="button"
            disabled={saving}
            onClick={() => void advance(step.status)}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
          >
            <PackageCheck size={18} /> {saving ? "Saving…" : step.label}
          </button>
          {/* The line under the button, carried by the rung. For the delivered
              rung this is the sentence that names the signature, photo and
              location this scan does NOT capture (bug 0481). */}
          <p className="text-xs text-ink-secondary">{step.note}</p>
          {isRun && (
            <p className="text-xs text-ink-secondary">
              This records the step for every drop on this run that is ready for it. Anything already done, on
              hold, or on another company&apos;s books is left alone and listed back to you.
            </p>
          )}
        </>
      )}

      {/* BEFORE the press, the run shows what it is about to touch — the driver
          should not have to press to find out a drop is held or foreign. */}
      {isRun && !done && (
        <RunList
          rows={(data as TripSummary).members.map((m) => ({
            stopNo: m.stopNo,
            doNumber: m.doNumber,
            tone: m.blockReason ? "warn" : "ok",
            text: m.blockReason ?? `${statusLabel("do", m.status)} — ${m.step ? m.step.label : "no step"}`,
          }))}
        />
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {/* THE PILE. Closed by default and one button wide, so this page reads
          exactly as it did for anyone holding a single paper — the owner asked
          for the feature and asked for the screens to stop moving in the same
          breath. Not offered on a packing list: that sheet already moves its
          whole run with its own button, and a basket beside it would be two
          ways to do one thing. */}
      {!isRun && <PublicDoScanBasket />}
    </Frame>
  );
}

/**
 * The run, drop by drop.
 *
 * A member with no document number is one on another company's books: it is
 * named by its STOP NUMBER and nothing else, deliberately — printing the other
 * company's document number on a page anyone holding the sheet can open is the
 * leak, not the fix.
 */
function RunList({
  rows,
}: {
  rows: Array<{ stopNo: number; doNumber: string | null; tone: "ok" | "warn"; text: string }>;
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
          <div className="min-w-0">
            <div className="font-mono font-semibold">{r.doNumber ?? "Not on this run's account"}</div>
            <div className={r.tone === "ok" ? "text-ink-secondary" : "text-amber-800"}>{r.text}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-4 p-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-ink-muted">Delivery</div>
        <h1 className="text-lg font-semibold">Scan delivery order</h1>
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
  /* Hold shares amber with the other refusals on purpose — a hold is reversible
     and deliberate, and red is what this system reserves for cancelled. Only the
     ICON differs, the same rule DoLoadScan and HoldChip state. */
  return (
    <div
      className={`flex items-start gap-3 rounded-md border px-4 py-4 text-sm ${
        tone === "ok"
          ? "border-emerald-300 bg-emerald-50 text-emerald-900"
          : "border-amber-300 bg-amber-50 text-amber-900"
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
