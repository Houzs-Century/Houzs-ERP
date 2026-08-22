/* ----------------------------------------------------------------------------
   PrintChainProvider — one Print preview dialog for the whole SCM shell, opened
   imperatively for ANY document, from anywhere, without leaving the page.

   THE OWNER'S ASK (2026-08-22): 「正常我们 print PDF 都是点进去 print 的吧。那我
   要在这边 right click，可以点 print SalesOrder、print DO，这样的意思其实就是
   print PDF」 — stay on the LIST and print any document in that row's chain.
   And 「要的啊，我是要全部的 Transaction Flow 都要」 when asked whether it was
   only the Sales Order.

   WHY A PROVIDER AND NOT A MODAL PER LIST. Two reasons, one of them measured.

     · The SHAPE. `usePrintPreview` + `<PrintPreviewModal>` mounted per page is
       right for a DETAIL page, which prints exactly one document and knows
       which. A list prints any of nine, chosen at right-click time, so the
       dialog belongs where `useConfirm` / `useChoice` / `useNotify` already
       live: mounted once in `Scm2990Shell`, reached by a hook. Same pattern,
       same z-index band, same "one dialog" invariant.

     · The COST, in lines. `MfgDeliveryOrdersListV2.tsx` is at its file-size
       ceiling exactly (2004 of 2004 on 2026-08-23) and `MfgSalesOrdersListV2`
       has three lines of headroom. Mounting a modal and its three handlers in
       each of the ten lists does not fit, and `scripts/file-size-ceilings.json`
       may only ever FALL. An imperative `printDocument(target)` costs each list
       ONE import and turns `print: goPrint` into `print: printDocument`.

   IT IS STILL `PrintPreviewModal`. The owner's 2026-08-06 rule — 「全部打印的时
   候都需要有这个」 — is that EVERY print goes through the preview, and this
   renders that component, not a second dialog that looks like it. Its three
   exits are unchanged: View full PDF / Print now / Download PDF, all through
   the PDF (`action`), never `window.print()`, which prints a blank sheet from
   any page in this app (`index.css`'s `@media print` block).

   THE FETCH HAPPENS ON THE CLICK, ONCE. Not per row and not per menu — a menu
   that cost a round trip per row would be worse than the navigation it
   replaces, and these lists page 50 rows at a time. `printChain.ts` builds the
   entries from what the row already carries; this only runs after the operator
   has picked one.
   ---------------------------------------------------------------------------- */

import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { PrintPreviewModal } from "./PrintPreviewModal";
import { useNotify } from "../../vendor/scm/components/NotifyDialog";
import { TRANSFER_DOC } from "../../vendor/shared/transfer-vocabulary";
import type { PrintTarget } from "../../lib/printChain";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";
/* `printPreviewRows` lives in printDocumentPdf.ts beside the fetch that shapes
   the header it reads. It is pure and tiny, so it is imported statically while
   the fetch and the generators stay behind the dynamic imports below — that is
   what keeps jspdf out of every list's bundle. */
import { printPreviewRows } from "../../lib/printDocumentPdf";

/** Open the print preview for one document. Never navigates. */
export type PrintDocumentFn = (target: PrintTarget) => void;

const PrintChainContext = createContext<PrintDocumentFn | null>(null);

type Loaded = { header: Record<string, unknown>; items: unknown[]; payments?: unknown[]; pwpCodes?: unknown[] };

export function PrintChainProvider({ children }: { children: ReactNode }) {
  const notify = useNotify();
  const [target, setTarget] = useState<PrintTarget | null>(null);
  /* The card's summary lines. Null while the detail read is in flight, so the
     band shows the document type and number — which the row already knew — and
     the lines fill in a beat later instead of the dialog waiting to open. */
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  /* The read the dialog is waiting on, held as a PROMISE and not only as its
     result, so "Print now" clicked while the card still says Loading waits for
     the document instead of doing nothing — a dead click is the "failure that
     reaches nobody" shape this repo keeps paying for. The target rides along so
     a resolved read is applied only while it is still the live one: a slow
     Sales Order must not fill in the card of the Delivery Order the operator
     picked after giving up on it, nor reopen a dialog that has been closed. */
  const read = useRef<{ target: PrintTarget; promise: Promise<Loaded> } | null>(null);

  const printDocument = useCallback<PrintDocumentFn>((t) => {
    setLoaded(null);
    setTarget(t);
    const promise = import("../../lib/printDocumentPdf").then((m) => m.fetchPrintBundle(t));
    read.current = { target: t, promise };
    void promise.then(
      (bundle) => { if (read.current?.target === t) setLoaded(bundle); },
      (e: unknown) => {
        if (read.current?.target !== t) return;
        read.current = null;
        setTarget(null);
        void notify({
          title: "Could not load the document",
          body: e instanceof Error ? e.message : "Something went wrong.",
          tone: "error",
        });
      },
    );
  }, [notify]);

  const deliver = useCallback(async (action: PdfAction) => {
    const cur = read.current;
    if (!cur) return;
    try {
      const bundle = await cur.promise;
      const { renderPrintBundle } = await import("../../lib/printDocumentPdf");
      await renderPrintBundle(cur.target, bundle, action);
    } catch (e) {
      void notify({
        title: "PDF generation failed",
        body: e instanceof Error ? e.message : "Something went wrong.",
        tone: "error",
      });
    }
  }, [notify]);

  const close = useCallback(() => { read.current = null; setTarget(null); setLoaded(null); }, []);
  /* Print and download close the dialog once the render RESOLVES, never before
     — the same rule `usePrintPreview` states, so a slow document can show
     "Preparing…" instead of vanishing. A new-tab preview leaves it open: the
     operator looked, and now wants to print. */
  const finish = useCallback(async (action: PdfAction) => { await deliver(action); close(); }, [deliver, close]);

  const rows = useMemo(() => {
    if (!target) return [];
    if (!loaded) return [{ value: "Loading document details…" }];
    /* Built by the module that fetched it, so the card and the PDF read the
       same header rather than two opinions of it. */
    return printPreviewRows(target, loaded.header);
  }, [target, loaded]);

  return (
    <PrintChainContext.Provider value={printDocument}>
      {children}
      {target && (
        <PrintPreviewModal
          open
          onClose={close}
          docTitle={TRANSFER_DOC[target.doc]}
          docNo={target.docNo}
          rows={rows}
          onViewPdf={() => deliver("preview")}
          onPrint={() => finish("print")}
          onDownload={() => finish("save")}
        />
      )}
    </PrintChainContext.Provider>
  );
}

/**
 * Print any document, by type and address, without leaving the page.
 *
 * ```ts
 * const printDocument = usePrintDocument();
 * printDocument({ doc: "do", docNo: "HC-DO-2608-003", key: doRow.id });
 * ```
 */
export function usePrintDocument(): PrintDocumentFn {
  const fn = useContext(PrintChainContext);
  if (!fn) throw new Error("usePrintDocument must be used within <PrintChainProvider>");
  return fn;
}
