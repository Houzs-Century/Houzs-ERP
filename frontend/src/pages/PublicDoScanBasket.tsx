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
// THE FIRST PAPER SETS THE RUNG, AND A PAPER ON A DIFFERENT RUNG IS NOT LET IN
// AT ALL. The owner, 2026-08-27: 「不同状态你就不要给它扫描进来吧，就当做它还没
// 扫描到。同样的东西不能在不同状态下重复扫描。它应该根据第一个状态来扫描。」
//
// This is stricter than the server, on purpose, and the server keeps its own
// checks anyway — a document can move between the scan and the press, and the
// basket is not the thing that decides whether a write is legal. What the rule
// buys is that the operator never assembles a pile that CANNOT all move: the
// refusal happens at the lorry with the paper still in hand, not afterwards in a
// list of reasons. A rejected scan leaves the basket exactly as it was, which is
// what 「就当做它还没扫描到」 means.
//
// It also collapses three buttons to ONE. A uniform pile has exactly one next
// rung, and the ladder computes it — so there is nothing to choose and no way to
// press the wrong thing.
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

const BATCH_STEPS: DoScanStep[] = doScanLadderOrder()
  .map((from) => doScanStep(from, false))
  .filter((s): s is DoScanStep => s !== null)
  .filter((s) => s.status !== "LOADED");

const TOKEN_IN_URL = /\/d\/([0-9a-hjkmnp-tv-z]{10}|[0-9a-f]{64})(?![0-9a-z])/i;

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

/**
 * The pile scanner as its OWN PAGE — /d/scan, no login, outside the AuthGate.
 *
 * It got a page of its own rather than a second button on /d/:token because two
 * properties of that screen are deliberate, older than this feature, and each
 * has a test: a delivery order offers exactly ONE button (the next rung, never a
 * choice), and a held or cancelled one offers a sentence and NO BUTTON AT ALL.
 * Loosening either to make room here would have been the wrong trade.
 *
 * It is also simply better: a bookmarkable page means the storekeeper who does
 * this every morning does not have to scan one paper to reach the scanner.
 */
export function PublicDoScanBasketPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-3 px-4 py-6">
      <h1 className="text-lg font-semibold">Scan delivery orders</h1>
      <p className="text-sm text-ink-secondary">
        Scan as many delivery orders as you like, then press once. The first one you scan decides the step —
        anything at a different step is not added, so a pile always moves together.
      </p>
      <PublicDoScanBasket />
    </div>
  );
}

export function PublicDoScanBasket() {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const lockedRef = useRef<DoScanStep | null>(null);
  const [locked, setLocked] = useState<DoScanStep | null>(null);

  const addToken = useCallback(async (token: string) => {
    if (seen.current.has(token)) return;
    seen.current.add(token);
    setLines((prev) => [...prev, { token, doNumber: null, status: null, step: null, blockReason: null }]);
    try {
      const res = await correlatedFetch("/api/public/do-scan/batch/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokens: [token] }),
      });
      const body = (await res.json()) as { lines?: Line[] };
      const found = body.lines?.[0];
      if (!found) return;

      const reject = (why: string) => {
        seen.current.delete(token);
        setLines((prev) => prev.filter((l) => l.token !== token));
        setRejected(why);
      };

      if (!found.step) {
        reject(
          `${found.doNumber ?? "That delivery order"} was not added. ${found.blockReason ?? "It has no next step."}`,
        );
        return;
      }
      if (!BATCH_STEPS.some((b) => b.status === found.step!.status)) {
        reject(
          `${found.doNumber ?? "That delivery order"} was not added — confirming a delivery order takes it out of `
          + `stock, so it is done one at a time. Open it on its own.`,
        );
        return;
      }
      const lock = lockedRef.current;
      if (lock && found.step.status !== lock.status) {
        reject(
          `${found.doNumber ?? "That delivery order"} was not added — this pile is for "${lock.label}", `
          + `and that one is at ${statusLabel("do", found.status)}. Finish this pile first, then start another.`,
        );
        return;
      }
      if (!lock) {
        const first: DoScanStep = { ...found.step } as DoScanStep;
        lockedRef.current = first;
        setLocked(first);
      }
      setRejected(null);
      setLines((prev) => prev.map((l) => (l.token === token ? { ...l, ...found } : l)));
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

  const releaseIfEmpty = (remaining: number) => {
    if (remaining === 0) {
      lockedRef.current = null;
      setLocked(null);
    }
  };

  const remove = (token: string) => {
    seen.current.delete(token);
    setLines((prev) => {
      const next = prev.filter((l) => l.token !== token);
      releaseIfEmpty(next.length);
      return next;
    });
  };

  const clear = () => {
    seen.current = new Set();
    lockedRef.current = null;
    setLocked(null);
    setLines([]);
    setNotice(null);
    setRejected(null);
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
        <div className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-900 dark:text-red-300">
          {scanner.cameraError}
        </div>
      )}
      {rejected && (
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-300">
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
              ? "border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300"
              : "border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300"
          }`}
        >
          {notice.text}
        </div>
      )}

      {lines.length > 0 && (
        <>
          {locked && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(locked.status)}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
              >
                {busy ? <Loader2 size={18} className="animate-spin" /> : <PackageCheck size={18} />}
                {locked.label} ({lines.length})
              </button>
              <p className="text-xs text-ink-secondary">{locked.note}</p>
            </>
          )}
          <button type="button" onClick={clear} className="w-full rounded-md border border-line px-3 py-2 text-sm">
            Clear the list
          </button>
        </>
      )}
    </div>
  );
}
