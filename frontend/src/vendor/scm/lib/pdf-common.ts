
import {
  getBrandingCache,
  getBrandingCompanyCode,
  getBrandingLogoCache,
} from '../../../lib/branding';
import { setPdfHost } from '../../../../../shared/src/vendor/scm/lib/pdf-host';
import { letterheadFromBranding } from '../../../../../shared/src/vendor/scm/lib/pdf-letterhead';
import type { FontAssetUrl } from '../../../../../shared/src/vendor/scm/lib/pdf-core';

export * from '../../../../../shared/src/vendor/scm/lib/pdf-core';

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

function openPdfViewerOverlay(blob: Blob, filename: string, opts: { print?: boolean } = {}): void {
  const blobUrl = URL.createObjectURL(blob);
  const title = filename.replace(/\.pdf$/i, '');
  const prevOverflow = document.body.style.overflow;

  const backdrop = document.createElement('div');
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);
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
    }
  };
  button('Print', true, printFrame);
  button('Download', false, () => deliverPdfBlob(blob, filename, 'save'));
  button('New tab', false, () => openPdfPreviewTab(blob, URL.createObjectURL(blob), filename));
  button('Close', false, () => close());

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
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

function openPdfPreviewTab(blob: Blob, blobUrl: string, filename: string): void {
  const tab = window.open('', '_blank');
  if (!tab) {
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
    }
    writeNamedPdfTab(tab, blobUrl, filename);
  })();
}

const PRINT_CACHE = 'houzs-print-preview';
const PRINT_PREFIX = '/print-preview/';
const PRINT_KEEP = 5;

async function putPrintPreview(
  blob: Blob,
  filename: string,
): Promise<string | null> {
  if (typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return null;
  const probe = await fetch(`${PRINT_PREFIX}__probe`, { cache: 'no-store' }).catch(() => null);
  if (!probe || probe.headers.get('x-houzs-print-preview') !== '1') return null;

  const cache = await caches.open(PRINT_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - (PRINT_KEEP - 1))).map((k) => cache.delete(k)));

  const path = PRINT_PREFIX + encodeURIComponent(filename);
  await cache.put(
    path,
    new Response(blob, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    }),
  );
  return path;
}

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
  const frame = tab.document.querySelector('iframe');
  const printFrame = () => {
    try {
      frame?.contentWindow?.focus();
      frame?.contentWindow?.print();
    } catch {
    }
  };
  tab.document.querySelector('[data-print]')?.addEventListener('click', printFrame);
}

