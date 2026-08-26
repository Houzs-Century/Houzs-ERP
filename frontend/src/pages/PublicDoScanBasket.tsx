// ----------------------------------------------------------------------------
// PublicDoScanBasket — scan a PILE of delivery orders, then press once.
//
// THE OWNER, 2026-08-26: 「我不能 scan 好几个 DO，然后一起点 load 吗？包括我的
// dispatch 也是一样，它应该可以支持连续扫描的。当我扫描越来越多的时候，不一定要
// 只扫一张。」
//
// WHY IT IS A SEPARATE FILE AND NOT A REWRITE OF PublicDoScan. The owner's other
// instruction the same day was to stop reworking screens and make the thing
// work. The single-paper page is untouched: this mounts BELOW it, closed, as one
// button. Nobody who wants the old behaviour has to learn anything.
//
// WHY THE PAGE NEEDS ITS OWN CAMERA. The phone's camera app opens the URL and
// navigates away, taking any basket with it. Continuous scanning is only
// possible inside a page that never leaves — see lib/use-qr-scanner.ts, which is
// Hookka's loop with its hard-won rules intact.
//
// WHICH RUNGS ARE OFFERED, AND THE ONE THAT IS NOT. The three buttons are
// DERIVED from the ladder, never typed here. DRAFT -> LOADED is deliberately
// excluded: it is the rung that CONFIRMS a delivery order and takes the goods
// out of stock, and doing that to a pile at once, from a page with no login, is
// a different class of risk from moving papers that already left the warehouse.
// Everything in this basket is past the deduction. If the office ever wants
// batch confirmation it should be a decision, not something that arrived because
// a loop happened to include it.
// ----------------------------------------------------------------------------
import { useCallback, useRef, useState } from "react";
import { Camera, Flashlight, Loader2, PackageCheck, Trash2, X } from "lucide-react";
import { useQrScanner } from "../lib/use-qr-scanner";
import { statusLabel } from "../vendor/scm/lib/status-pill";
import { doScanLadderOrder, doScanStep, type DoScanStep } from "../vendor/shared/do-scan-ladder";
import { correlatedFetch } from "../lib/requestCorrelation";

/* THE RUNGS A PILE MAY BE MOVED TO, walked out of the ladder rather than typed.
   Add a rung to the ladder and it appears here; there is no second list to
   forget. LOADED is dropped for the reason in the header. */
const BATCH_STEPS: DoScanStep[] = doScanLadderOrder()
  .map((from) => doScanStep(from, false))
  .filter((s): s is DoScanStep => s !== null)
  .filter((s) => s.status !== "LOADED");

/* THE ONLY SHAPE THIS BASKET CAN READ. The printed QR encodes `${origin}/d/<64
   hex>`; the token is the credential and nothing else on the paper identifies
   the document to a page with no login. Matched on the PATH, not the origin, so
   a sheet printed under an old domain still scans. */
const TOKEN_IN_URL = /\/d\/([0-9a-f]{64})\b/i;

type Line = {
  token: string;
  doNumber: string | null;
  customerName?: string;
  area?: string;
  status: string | null;
  step: { status: string; label: string; note: string } | null;
  blockReason: string | null;
  outcome?: string;
  message?: string;
};

export function PublicDoScanBasket() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  /* The tokens already in the basket, as a ref rather than state: the decode
     loop fires from a callback that must see the CURRENT set, and a state
     snapshot captured at subscribe time would let the same paper in twice. */
  const seen = useRef<Set<string>>(new Set());

  const addToken = useCallback(async (token: string) => {
    if (seen.current.has(token)) return;
    seen.current.add(token);
    /* The line appears IMMEDIATELY, before the lookup answers. A storekeeper
       moving down a pile needs to see the count go up as fast as they scan;
       waiting for a round trip makes it feel like the scan missed. */
    setLines((prev) => [...prev, { token, doNumber: null, status: null, step: null, blockReason: null }]);
    try {
      const res = await correlatedFetch("/api/public/do-scan/batch/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      const body = (await res.json()) as { lines?: Line[] };
      const found = body.lines?.[0];
      if (found) setLines((prev) => prev.map((l) => (l.token === token ? { ...l, ...found } : l)));
    } catch {
      setLines((prev) =>
        prev.map((l) =>
          l.token === token
            ? { ...l, blockReason: "Could not reach the office just now. It will still be sent when you press." }
            : l,
        ),
      );
    }
  }, []);

  const onDecoded = useCallback(
    (value: string) => {
      const m = TOKEN_IN_URL.exec(value);
      if (!m) {
        /* NAMED, NEVER IGNORED. A paper whose QR points at the logged-in page
           decodes perfectly and cannot be used here, and an operator who scans
           it repeatedly with nothing happening will decide the scanner is
           broken. */
        setRejected(
          "That code is not a delivery order this page can read. It may have been printed before the QR was changed — ask the office to reprint it.",
        );
        return;
      }
      setRejected(null);
      void addToken(m[1]!.toLowerCase());
    },
    [addToken],
  );

  const scanner = useQrScanner(onDecoded);

  const remove = (token: string) => {
    seen.current.delete(token);
    setLines((prev) => prev.filter((l) => l.token !== token));
  };

  const clear = () => {
    seen.current = new Set();
    setLines([]);
    setNotice(null);
  };

  async function send(to: string) {
    if (!lines.length || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await correlatedFetch("/api/public/do-scan/batch/advance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokens: lines.map((l) => l.token), to }),
      });
      const body = (await res.json()) as {
        outcome?: string; message?: string; lines?: Line[]; error?: string;
      };
      if (!res.ok) {
        setNotice({ tone: "warn", text: body.message ?? "That did not go through. Try again." });
        return;
      }
      /* THE LINES ARE REPLACED BY WHAT THE SERVER SAID HAPPENED, one per paper.
         An operator told "8 of 11 recorded" without being told WHICH three has
         to re-scan the whole pile to find out. */
      if (body.lines) {
        setLines((prev) =>
          prev.map((l) => {
            const r = body.lines!.find((x) => x.token === l.token);
            return r ? { ...l, ...r } : l;
          }),
        );
      }
      setNotice({
        tone: body.outcome === "PARTIAL" ? "warn" : "ok",
        text: body.message ?? "Recorded.",
      });
    } catch {
      setNotice({ tone: "warn", text: "Could not reach the office. Nothing was recorded — try again." });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-surface px-4 py-3 text-sm font-semibold"
      >
        <Camera size={16} /> Scan several delivery orders
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-line bg-surface p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">
          Scanned: {lines.length}
        </div>
        <button
          type="button"
          onClick={() => { scanner.stop(); setOpen(false); }}
          className="rounded p-1 text-ink-secondary"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      {scanner.scanning ? (
        <div className="space-y-2">
          {/* playsInline keeps iOS from taking the video full-screen, which
              would hide the running count the operator is watching. */}
          <video ref={scanner.videoRef} playsInline muted className="w-full rounded-md bg-black" />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={scanner.stop}
              className="flex-1 rounded-md border border-line px-3 py-2 text-sm"
            >
              Stop camera
            </button>
            {scanner.torchSupported && (
              <button
                type="button"
                onClick={() => void scanner.toggleTorch()}
                className="rounded-md border border-line px-3 py-2 text-sm"
                aria-label="Torch"
              >
                <Flashlight size={16} />
              </button>
            )}
          </div>
          <p className="text-xs text-ink-secondary">
            Keep scanning — the camera stays open and each delivery order is added once.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void scanner.start()}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-base font-semibold text-white"
        >
          <Camera size={18} /> Start camera
        </button>
      )}

      {scanner.cameraError && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {scanner.cameraError}
        </div>
      )}
      {rejected && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {rejected}
        </div>
      )}

      {lines.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {lines.map((l) => (
            <li key={l.token} className="flex items-start justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-mono font-semibold">
                  {l.doNumber ?? <span className="text-ink-secondary">Reading…</span>}
                </div>
                {l.customerName && <div className="truncate">{l.customerName}</div>}
                <div className="text-xs text-ink-secondary">
                  {l.status ? statusLabel("do", l.status) : "—"}
                  {l.message ? ` · ${l.message}` : l.blockReason ? ` · ${l.blockReason}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(l.token)}
                className="shrink-0 rounded p-1 text-ink-secondary"
                aria-label={`Remove ${l.doNumber ?? "this delivery order"}`}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <div
          className={`rounded-md px-3 py-2 text-sm ${
            notice.tone === "warn"
              ? "border border-amber-300 bg-amber-50 text-amber-900"
              : "border border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}
        >
          {notice.text}
        </div>
      )}

      {lines.length > 0 && (
        <>
          <div className="space-y-2">
            {BATCH_STEPS.map((s) => (
              <button
                key={s.status}
                type="button"
                disabled={busy}
                onClick={() => void send(s.status)}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : <PackageCheck size={18} />}
                {s.label} ({lines.length})
              </button>
            ))}
          </div>
          {/* THE PILE IS NOT UNIFORM AND THE OPERATOR IS TOLD SO BEFORE PRESSING.
              Only the papers on that rung move; the rest come back with a line
              each saying why. */}
          <p className="text-xs text-ink-secondary">
            Only the delivery orders ready for the step you press will move. Anything already past it, on hold or
            cancelled is left alone and listed back to you.
          </p>
          <button type="button" onClick={clear} className="w-full rounded-md border border-line px-3 py-2 text-sm">
            Clear the list
          </button>
        </>
      )}
    </div>
  );
}
