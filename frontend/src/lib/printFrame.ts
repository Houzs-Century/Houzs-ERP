/* Printing named after the document.

   Chrome names "Save as PDF" after the TOP page's title, so every print saved
   as "Houzs Century ERP.pdf" (owner 2026-11-25, a Supplier Service Order): the
   hidden-iframe prints, whose iframe title Chrome ignores, and the sheets that
   print the page itself. For the length of the print dialog the tab carries
   the document's title, then gets its own back. */

/** Characters Windows and macOS refuse in a file name become "-". */
export function fileTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
}

function retitleWhilePrinting(title: string, printing: Window): void {
  const name = fileTitle(title);
  if (!name) return;
  const prev = document.title;
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    // Only undo our own change: a page that retitled itself meanwhile keeps its title.
    if (document.title === name) document.title = prev;
  };
  document.title = name;
  printing.addEventListener("afterprint", restore, { once: true });
  if (printing !== window) window.addEventListener("afterprint", restore, { once: true });
  // Some browsers never fire afterprint for an iframe; the dialog is long closed by then.
  window.setTimeout(restore, 60_000);
}

/** Print an HTML document mounted in a hidden iframe. */
export function printFrameAs(frame: HTMLIFrameElement, title: string): void {
  const win = frame.contentWindow;
  if (!win) return;
  retitleWhilePrinting(title, win);
  win.focus();
  win.print();
}

/** Print this page itself (a sheet that index.css lets through). */
export function printPageAs(title: string): void {
  retitleWhilePrinting(title, window);
  window.print();
}
