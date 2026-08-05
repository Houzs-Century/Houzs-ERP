// ----------------------------------------------------------------------------
// scan-learning — post the operator's corrections back, and NOTICE when it fails.
//
// WHY THIS EXISTS. Owner, 2026-08-05: "他们更改了东西之后，你有没有去学习？要不然，
// 他们如果没有自我进化的话，这个 OCR 永远都会不准".
//
// A production check answered that on 2026-08-05, and the answer was no:
//
//     rows total                 40
//     with a CORRECTED payload    2     (both from a TEST account)
//     status = CONFIRMED          0
//     last scan            Aug 05
//     last correction      Jul 18
//     so_scan_rules               0
//
// Every real salesperson sits at ZERO corrections — Lim 13 scans, HOUZS CENTURY
// 10, Anthony 3, Pei Fen 2, all with none written back. So the few-shot pool the
// extractor draws from is empty for every one of them, and the scanner starts
// from scratch on every slip. The mechanism is built; it is not running.
//
// SISTER SYSTEM, SAME BUG, ALREADY DIAGNOSED. Hookka ERP hit this exactly
// (`fix(ocr): a dropped accuracy sample no longer disappears silently`,
// 5ea07668):
//
//     Both scan modals post the imported document back … fire-and-forget with
//     `.catch(() => {})`. But `.catch` only sees a NETWORK failure — a 403, 404
//     or 500 resolves normally and was thrown away unread.
//     Which is how July recorded ZERO samples: 308 sales order imports and 119
//     supplier imports, none of them written, nothing anywhere to say so.
//
// Houzs had the identical line on both surfaces.
//
// WHAT THIS CHANGES, and what it deliberately does NOT. Learning stays
// best-effort: a failed write must never block the operator's save, and it still
// does not. What changes is that a failure stops being SILENT — it is reported
// through the same reporter every other client fault uses, so the next time the
// pool is empty there is a record saying why instead of an absence to guess at.
//
// It also reports the SKIP. `maybeLearnFromScan` returns early when the sample
// id or the frozen AI original is missing, and that path wrote nothing and said
// nothing — indistinguishable from a write that failed. Given 40 scans and 0
// confirmations, which of the two is happening is the whole question.
// ----------------------------------------------------------------------------

import { reportClientError } from '../../../lib/errorReporter';

/** Why a scan produced no learning sample. Reported, never thrown. */
export type ScanLearningSkip = 'not-from-scan' | 'no-sample-id' | 'no-ai-original';

/**
 * Record that a scan-seeded save taught the extractor NOTHING, and why.
 *
 * Called from the early-return in `maybeLearnFromScan`. Silent skips are how a
 * feature dies without anyone noticing: the code runs, returns, and the pool
 * stays empty forever.
 */
export function reportScanLearningSkipped(reason: ScanLearningSkip, surface: 'mobile' | 'desktop'): void {
  /* not-from-scan is the overwhelmingly common case — a normal hand-typed SO —
     and is not worth a report. The other two mean a SCAN happened and its
     correction was lost. */
  if (reason === 'not-from-scan') return;
  reportClientError(
    new Error(`scan learning skipped: ${reason}`),
    `scan-learning/${surface}`,
  );
}

/**
 * POST the corrected sample and CHECK THE OUTCOME.
 *
 * `fetcher` is the caller's authedFetch, so this stays free of the auth layer.
 * Returns nothing and never throws: the save path is unchanged. The difference
 * is that a 4xx/5xx now leaves a trace instead of vanishing.
 */
export async function postScanLearningSample(
  fetcher: (path: string, init: { method: string; body: string }) => Promise<unknown>,
  sampleId: string,
  body: unknown,
  surface: 'mobile' | 'desktop',
): Promise<void> {
  try {
    await fetcher(`/scan-so/samples/${sampleId}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (err) {
    /* Best-effort still — swallowed for the OPERATOR, recorded for us. Whether
       authedFetch rejects on a non-2xx or resolves with it, either way the
       failure now reaches the reporter rather than a no-op arrow function. */
    reportClientError(err, `scan-learning/${surface}/confirm-failed`);
  }
}
