// ----------------------------------------------------------------------------
// Print preview — the ONE dialog every printable document opens.
//
// Until 2026-08-06 exactly one surface had it: the Delivery Order detail page,
// as a private component. Every other Print PDF button in the app (SO, SI, DR,
// PO, GRN, PI, PR, the four consignment documents, both amendment kinds, their
// mobile twins, and the lists' batch Export PDF) went straight from click to a
// file landing in Downloads, with no chance to check you had the right document
// or to send it to a printer instead. Owner, 2026-08-06: "全部打印的时候都需要
// 有这个".
//
// Shape (owner's pick): a lightweight SUMMARY card — letterhead band naming the
// active company + document type + doc no, then a handful of identifying lines
// — rather than rendering the real PDF up front, which would make every button
// wait on a jspdf render (the supplier documents pull a fabric catalogue and are
// measurably slow). "View full PDF" is the escape hatch when the summary is not
// enough: it renders the true document into a new tab.
//
// The three exits map onto the shared PdfAction in vendor/scm/lib/pdf-common:
//   View full PDF → 'preview'   Print now → 'print'   Download PDF → 'save'
//
// NOTE for anyone adding a print button: "Print now" must go through the PDF
// (action: 'print'), NOT window.print(). The global @media print block in
// index.css hides `body *` and reveals only `.org-print-area`, so window.print()
// on any document page prints a blank sheet — which is precisely what the DO's
// own "Print now" did before this component existed.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FileText, Printer } from "lucide-react";
import { Button } from "../Button";
import { ModalOverlay } from "./DocumentRelationshipMapModal";
import { useBranding } from "../../hooks/useBranding";
import { shortCompanyName } from "../../lib/branding";
import type { PdfAction } from "../../vendor/scm/lib/pdf-common";

/* Every print button in the app is the same three lines of state, so they live
   here once. Pass the page's generator call; get back the dialog's open state
   and its three handlers, ready to spread.

     const print = usePrintPreview((action) =>
       import("…/sales-invoice-pdf").then(({ generateSalesInvoicePdf }) =>
         generateSalesInvoicePdf(header, items, { action })));
     …
     <Button onClick={print.openPreview}>Print PDF</Button>
     <PrintPreviewModal open={print.open} onClose={print.close}
       docTitle="Sales Invoice" docNo={header.invoice_number}
       rows={rows} {...print.handlers} />

   Print and download close the dialog once the render RESOLVES (not before), so
   the button can show "Preparing…" while a slow document is drawn. A new-tab
   preview leaves it open — the operator looked, and now wants to print. */
export function usePrintPreview(deliver: (action: PdfAction) => void | Promise<void>) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const finishWith = useCallback(
    async (action: PdfAction) => {
      await deliver(action);
      setOpen(false);
    },
    [deliver],
  );
  return {
    open,
    openPreview: useCallback(() => setOpen(true), []),
    close,
    handlers: {
      onViewPdf: useCallback(() => deliver("preview"), [deliver]),
      onPrint: useCallback(() => finishWith("print"), [finishWith]),
      onDownload: useCallback(() => finishWith("save"), [finishWith]),
    },
  };
}

/* Every SCM list's row drawer has a Print button that navigates to the detail
   page with `?print=1`. NOTHING has ever consumed that param — eight buttons
   that just opened the record and sat there. Now the detail page opens its
   Print preview on arrival, which is what the drawer meant all along.

   `ready` gates on the record being loaded, so the dialog never opens over an
   empty header. The ref makes it fire ONCE: closing the preview must not be
   undone by the next render, and the param stays in the URL. */
export function useOpenPrintPreviewFromUrl(open: () => void, ready: boolean) {
  const [params] = useSearchParams();
  const fired = useRef(false);
  const wanted = params.get("print") === "1";
  useEffect(() => {
    if (fired.current || !wanted || !ready) return;
    fired.current = true;
    open();
  }, [wanted, ready, open]);
}

/** One summary line. A row with no `label` renders as a plain muted paragraph —
 *  that is how an address block sits under "Deliver to: <customer>". */
export type PrintPreviewRow = {
  label?: string;
  value: ReactNode;
};

/* Handlers may be async (every generator is), so the dialog can disable itself
   while a document renders instead of letting an impatient second click queue a
   second render. */
type PrintAction = () => void | Promise<void>;

export function PrintPreviewModal({
  open,
  onClose,
  docTitle,
  docNo,
  companyName,
  rows,
  onViewPdf,
  viewLabel = "View full PDF",
  onPrint,
  onDownload,
}: {
  open: boolean;
  onClose: () => void;
  /** Document type under the company name, e.g. "Delivery Order". */
  docTitle: string;
  /** Document number in the band's right column. */
  docNo: string;
  /* Override the band's company. Needed where the document does NOT print on
     the active workspace's letterhead: a service case can be raised under one
     entity and handed to the customer on the other's paper, and the band has to
     name the one that will actually be printed — otherwise the picker says 2990
     while the card says Houzs (owner 2026-08-11: "我选了2990但是Preview还是
     Houzs"). Omit and the band follows the active company, which is right for
     every document that cannot be re-headed. */
  companyName?: string;
  rows: PrintPreviewRow[];
  /** Render the real PDF in a new tab. Omit to hide the button. */
  onViewPdf?: PrintAction;
  /** Label for that button — HTML surfaces open a page, not a PDF. */
  viewLabel?: string;
  onPrint: PrintAction;
  /** Omit on surfaces with no PDF to download — the HTML-printed pages (fleet
   *  run sheet, portal case, listing shell, org chart) print the page itself,
   *  so "Download PDF" would be a button with nothing behind it. */
  onDownload?: PrintAction;
}) {
  // Letterhead follows the ACTIVE company (2990 DO previews were once branded
  // with a hardcoded Houzs literal). Same source as the jspdf letterhead, so the
  // card and the document it previews always name the same company.
  const branding = useBranding();
  const [pending, setPending] = useState<"view" | "print" | "download" | null>(null);

  const run = (key: "view" | "print" | "download", fn: PrintAction) => async () => {
    if (pending) return;
    setPending(key);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  return (
    <ModalOverlay
      open={open}
      onClose={onClose}
      title="Print preview"
      icon={<Printer size={16} />}
      footer={
        <>
          {onViewPdf && (
            <Button
              variant="ghost"
              icon={<FileText size={14} />}
              /* The ghost variant carries no disabled styling of its own. */
              className="disabled:opacity-50"
              disabled={pending !== null}
              onClick={run("view", onViewPdf)}
            >
              {pending === "view" ? "Preparing…" : viewLabel}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              /* With no download beside it, Print IS the primary action. */
              variant={onDownload ? "secondary" : "primary"}
              icon={<Printer size={14} />}
              disabled={pending !== null}
              onClick={run("print", onPrint)}
            >
              {pending === "print" ? "Preparing…" : "Print now"}
            </Button>
            {onDownload && (
              <Button
                variant="primary"
                icon={<Download size={14} />}
                disabled={pending !== null}
                onClick={run("download", onDownload)}
              >
                {pending === "download" ? "Preparing…" : "Download PDF"}
              </Button>
            )}
          </div>
        </>
      }
    >
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <div className="flex items-start justify-between gap-3 bg-sidebar px-5 py-4 text-sidebar-ink">
          <div>
            <div className="font-display text-[14px] font-bold uppercase tracking-wider text-white">
              {shortCompanyName(companyName ?? branding.companyName)}
            </div>
            <div className="mt-0.5 text-[10.5px] uppercase tracking-brand text-sidebar-ink-muted">
              {docTitle}
            </div>
          </div>
          <div className="text-right font-mono text-[13px] font-bold text-accent-bright">
            {docNo}
          </div>
        </div>
        <div className="space-y-2 px-5 py-4 text-[12.5px] leading-relaxed text-ink">
          {rows.map((row, i) => (
            <div key={i} className={row.label ? undefined : "text-ink-secondary"}>
              {row.label && (
                <span className="font-semibold text-ink-secondary">{row.label}: </span>
              )}
              {row.value}
            </div>
          ))}
        </div>
      </div>
    </ModalOverlay>
  );
}

/* ── Batch preview ───────────────────────────────────────────────────────────
   The lists' "Export PDF (N)" merges several documents into one file, so there
   is no single doc no to head the card and no point summarising one of them.
   Same shell, same three exits; the card names the stack instead. */
export function PrintPreviewBatchModal({
  open,
  onClose,
  docTitle,
  docNos,
  onViewPdf,
  onPrint,
  onDownload,
}: {
  open: boolean;
  onClose: () => void;
  /** Plural document type, e.g. "Delivery Orders". */
  docTitle: string;
  /** Every doc no going into the file, in output order. */
  docNos: string[];
  onViewPdf?: PrintAction;
  onPrint: PrintAction;
  onDownload: PrintAction;
}) {
  /* Long selections would push the buttons off a laptop screen; the card lists
     the first ten and counts the rest, which is enough to confirm you ticked
     the right rows. */
  const shown = docNos.slice(0, 10);
  const rest = docNos.length - shown.length;
  return (
    <PrintPreviewModal
      open={open}
      onClose={onClose}
      docTitle={docTitle}
      docNo={`${docNos.length} document${docNos.length === 1 ? "" : "s"}`}
      rows={[
        { label: "Merged into", value: "one PDF file, each document on its own page" },
        {
          value: (
            <span className="font-mono">
              {shown.join(" · ")}
              {rest > 0 ? ` · +${rest} more` : ""}
            </span>
          ),
        },
      ]}
      onViewPdf={onViewPdf}
      onPrint={onPrint}
      onDownload={onDownload}
    />
  );
}
