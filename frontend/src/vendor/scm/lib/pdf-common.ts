// ----------------------------------------------------------------------------
// Shared helpers for jspdf-based document PDFs. Avoids copy-pasting the
// company header / footer across SI / PI / GRN / PR / DR PDFs.
//
// VENDORED from 2990's apps/backend/src/lib/pdf-common.ts (verbatim layout/logic)
// for the Houzs SCM module. ONLY change vs. source: the COMPANY letterhead block
// now carries HOUZS's registered entity (see below), not 2990's.
// ----------------------------------------------------------------------------

import {
  getBrandingCache,
  getBrandingCompanyCode,
  getBrandingLogoCache,
} from '../../../lib/branding';
import { setPdfHost } from './pdf-host';
import { letterheadFromBranding } from './pdf-letterhead';
import type { FontAssetUrl } from './pdf-core';

export * from './pdf-core';

/* base64 for addFileToVFS. Chunked because a 1.1 MB face is ~1.1 M arguments —
   one spread of that size blows the call stack. */
const fetchFaceBase64 = async (url: FontAssetUrl): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};


/* The BROWSER host: the letterhead comes from the centralised Branding config
   (one editable record in Settings → Branding), NOT from hardcoded literals. The
   pure (non-React) PDF libs can't use hooks, so they read the module-level
   branding cache (lib/branding.ts), which useBranding() primes the moment
   GET /api/branding resolves. Until then the cache holds DEFAULT_BRANDING —
   VERBATIM the values that were hardcoded here before — so a PDF drawn
   pre-fetch is byte-identical to the old output. Registered on import: every
   browser generator imports this file. */
setPdfHost({
  letterhead: () => letterheadFromBranding(getBrandingCache(), getBrandingCompanyCode()),
  companyLogo: getBrandingLogoCache,
  fontFace: (url) => fetchFaceBase64(url as FontAssetUrl),
});

// ── How a finished PDF reaches the operator ───────────────────────────────────
//
// Every document's Print preview offers the same three exits, so the delivery
// step lives here instead of being re-implemented per generator (it was written
// once, for the SO, and every other generator only knew doc.save()):
//
//   'save'    → download it (the historical default; keep it the fallback so an
//               un-migrated caller behaves exactly as before)
//   'print'   → blob → the in-app viewer below, with the browser's print
//               dialog opened on it once the PDF has laid out. The PDF must sit
//               in a VISIBLE iframe: a 0×0 hidden iframe's contentWindow.print()
//               is answered by Chrome's PDF viewer with nothing at all often
//               enough to be useless. Never window.print() on our own pages: the
//               global @media print block (index.css) hides `body *` and shows
//               only `.org-print-area`, so a detail page prints a BLANK sheet.
//   'preview' → blob → the same viewer without the auto-print, i.e. the "View
//               full PDF" escape hatch from the summary card.
//
// Both used to open a NEW TAB. That window.open runs only after the
// generator's jspdf render has been awaited, so the click's user gesture is
// gone and Chrome blocks it as a popup (owner 2026-10-02: "Print 不能在 ERP
// 里面…会跳去新的 window"). The viewer's "New tab" button is a fresh click, so
// that route still exists and is never blocked.
export type PdfAction = 'save' | 'print' | 'preview';

/** Deliver a rendered doc by the requested route. Defaults to a download. */
export function deliverPdf(
  doc: import('jspdf').jsPDF,
  filename: string,
  action: PdfAction = 'save',
): void {
  if (action === 'save') {
    doc.save(filename);
    return;
  }
  deliverPdfBlob(doc.output('blob'), filename, action);
}

/** The same three exits for a PDF that exists only as BYTES — a jsPDF page
 *  merged with stored attachments (pdf-attach.ts) is no longer a jsPDF doc,
 *  and re-parsing it into one just to deliver it would be a lossy detour.
 *  'save' mirrors doc.save(): an <a download> click. */
export function deliverPdfBlob(
  blob: Blob,
  filename: string,
  action: PdfAction = 'save',
): void {
  if (action === 'save') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    return;
  }
  openPdfViewerOverlay(blob, filename, { print: action === 'print' });
}

/* ── The in-app viewer ───────────────────────────────────────────────────────
 *
 * Plain DOM rather than React: deliverPdf is called from vendor generators with
 * no component tree to mount into. The PDF sits in a VISIBLE iframe (the
 * browser's own PDF viewer), so Print here prints the real document — not the
 * page, which index.css's @media print would blank. Esc / backdrop / Close all
 * tear it down and release the blob. */
function openPdfViewerOverlay(blob: Blob, filename: string, opts: { print?: boolean } = {}): void {
  const blobUrl = URL.createObjectURL(blob);
  const title = filename.replace(/\.pdf$/i, '');
  const prevOverflow = document.body.style.overflow;

  const backdrop = document.createElement('div');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);
  /* Above the Print preview modal it was opened from. */
  backdrop.style.cssText =
    'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.6);' +
    'display:flex;align-items:center;justify-content:center;padding:16px';

  const panel = document.createElement('div');
  panel.style.cssText =
    'display:flex;flex-direction:column;width:min(1100px,100%);height:100%;' +
    'background:#3a3a3a;border-radius:10px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.4)';

  const bar = document.createElement('div');
  bar.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1f2937;color:#fff;' +
    'font:600 13px/1.2 system-ui,sans-serif';

  const name = document.createElement('div');
  name.textContent = title;
  name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  bar.appendChild(name);

  const iframe = document.createElement('iframe');
  iframe.title = title;
  iframe.style.cssText = 'flex:1;width:100%;border:0;display:block;background:#525659';

  const button = (label: string, primary: boolean, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      'border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:600 12px/1 system-ui,sans-serif;' +
      (primary ? 'background:#0f766e;color:#fff' : 'background:rgba(255,255,255,.12);color:#fff');
    b.addEventListener('click', onClick);
    bar.appendChild(b);
    return b;
  };

  const printFrame = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      /* Viewer not hydrated yet — its own toolbar print button still works. */
    }
  };
  button('Print', true, printFrame);
  button('Download', false, () => deliverPdfBlob(blob, filename, 'save'));
  /* A fresh click, so this window.open keeps its user gesture. */
  button('New tab', false, () => openPdfPreviewTab(blob, URL.createObjectURL(blob), filename));
  button('Close', false, () => close());

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Capture + stop, so Esc closes only the viewer, not the Print preview under it.
    e.stopPropagation();
    close();
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    document.body.style.overflow = prevOverflow;
    URL.revokeObjectURL(blobUrl);
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);

  /* The browser's own Save takes its name from the address: a blob saves as a
     GUID (owner 2026-11-06), the worker's path saves as the document. An iframe
     with no src fires load too, so print listens only once the real one is set. */
  void (async () => {
    let path: string | null = null;
    try {
      path = await putPrintPreview(blob, filename);
    } catch {
      // Any storage/worker failure just means the blob, as in the preview tab.
    }
    if (opts.print) iframe.addEventListener('load', () => { window.setTimeout(printFrame, PRINT_SETTLE_MS); }, { once: true });
    iframe.src = path ?? blobUrl;
  })();

  panel.appendChild(bar);
  panel.appendChild(iframe);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
}

/* ── The preview tab ──────────────────────────────────────────────────────────
 *
 * Two routes, in order of how good the address bar looks:
 *
 *   1. `/print-preview/<filename>.pdf`, served by the service worker out of a
 *      cache this function writes. A REAL same-origin path, so the address bar
 *      reads the document — the whole point.
 *   2. A wrapper page whose <title> is the document, with the PDF in an iframe.
 *      Used when the worker is not in control: a first visit, a client still on
 *      an older worker, local dev (the worker deliberately never intercepts), or
 *      a browser with storage blocked. The tab is still NAMED correctly; only
 *      the address bar stays a blob.
 *
 * Route 1 must be PROVEN, not assumed. Without a worker, `/print-preview/x.pdf`
 * hits Pages' SPA catch-all and returns 200 + index.html — the operator would
 * get the ERP app where a document should be, with no error anywhere. So the
 * worker answers a probe with a sentinel header, and only that header switches
 * this on.
 *
 * The tab is opened SYNCHRONOUSLY, before any await: a `window.open` that
 * follows an await has lost the user gesture and is blocked as a popup. */
function openPdfPreviewTab(blob: Blob, blobUrl: string, filename: string): void {
  const tab = window.open('', '_blank');
  if (!tab) {
    // Popup blocked — the raw blob is still better than nothing.
    window.open(blobUrl, '_blank');
    return;
  }
  void (async () => {
    try {
      const path = await putPrintPreview(blob, filename);
      if (path) {
        tab.location.replace(path);
        return;
      }
    } catch {
      // Any storage/worker failure just means route 2.
    }
    writeNamedPdfTab(tab, blobUrl, filename);
  })();
}

const PRINT_CACHE = 'houzs-print-preview';
const PRINT_PREFIX = '/print-preview/';
/** Newest N previews kept; older entries are dropped on each write. */
const PRINT_KEEP = 5;

/* Put the PDF where the service worker can serve it, and return the path — or
   null when the worker is not in control (see openPdfPreviewTab). */
async function putPrintPreview(
  blob: Blob,
  filename: string,
): Promise<string | null> {
  if (typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return null;
  const probe = await fetch(`${PRINT_PREFIX}__probe`, { cache: 'no-store' }).catch(() => null);
  if (!probe || probe.headers.get('x-houzs-print-preview') !== '1') return null;

  const cache = await caches.open(PRINT_CACHE);
  /* Trim first, so a failure below cannot leave the cache growing. cache.keys()
     is insertion-ordered, so the oldest are at the front. */
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - (PRINT_KEEP - 1))).map((k) => cache.delete(k)));

  const path = PRINT_PREFIX + encodeURIComponent(filename);
  await cache.put(
    path,
    new Response(blob, {
      headers: {
        'Content-Type': 'application/pdf',
        /* `inline` so the browser RENDERS it rather than downloading; the
           filename still rides along, so Save from the viewer proposes the
           document's name. RFC 5987 encoding carries the CJK safely. */
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    }),
  );
  return path;
}

/* Route 2 — the fallback tab. A blob URL carries no name, so a bare
   `window.open(blobUrl)` lands the operator on a tab called `8a7f3c2e-1b4d-…`:
   two documents open side by side are indistinguishable and Save proposes the
   GUID. This wrapper cannot fix the address bar (only the service-worker route
   above can) but it does name the tab, the window title and the download. */
/** How long the viewer gets after its load event before the print dialog is
    asked for — Chrome fires load before the PDF is laid out, and a dialog
    asked for too early prints a blank sheet. */
const PRINT_SETTLE_MS = 400;

function writeNamedPdfTab(tab: Window, blobUrl: string, filename: string): void {
  const title = filename.replace(/\.pdf$/i, '');
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  tab.document.write(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${esc(title)}</title>` +
      `<style>html,body{margin:0;height:100%;background:#3a3a3a}` +
      `iframe{border:0;width:100%;height:100%;display:block}` +
      `.bar{position:fixed;right:14px;top:10px;z-index:2;display:flex;gap:8px}` +
      `.bar a,.bar button{font:600 12px/1 system-ui,sans-serif;background:#0f766e;color:#fff;padding:8px 12px;border-radius:6px;text-decoration:none;border:0;cursor:pointer}</style>` +
      `</head><body>` +
      `<div class="bar"><button type="button" data-print>Print</button>` +
      `<a href="${esc(blobUrl)}" download="${esc(filename)}">Download PDF</a></div>` +
      `<iframe src="${esc(blobUrl)}" title="${esc(title)}"></iframe>` +
      `</body></html>`,
  );
  tab.document.close();
  /* Wired from this side: the tab is an about:blank of our origin, so no inline
     script has to survive whatever policy the page is served under. */
  const frame = tab.document.querySelector('iframe');
  const printFrame = () => {
    try {
      frame?.contentWindow?.focus();
      frame?.contentWindow?.print();
    } catch {
      /* The viewer refused — the operator still has the button and the download. */
    }
  };
  tab.document.querySelector('[data-print]')?.addEventListener('click', printFrame);
  /* No revoke timer. The old code revoked after 60 s, which was safe when the
     tab was the blob itself (already loaded) but would quietly break this page's
     Download link the moment the operator took longer than a minute to decide.
     The blob dies with the opener page instead. */
}

