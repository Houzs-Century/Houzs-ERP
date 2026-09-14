// The id of the build this tab loaded, read from index.html.
//
// It USED to be a Vite `define` compiled into initial-app, and that single
// string renamed most of the bundle on every deploy: a chunk's file name hashes
// its content, the content held a timestamp, and every chunk importing
// initial-app inherited the new name. Measured 2026-09-14 — the same commit
// built twice renamed 391 of 561 files in dist/assets3 — so each of ~48 daily
// deploys deleted files an open tab still needed (HC-SO-012016's print of
// sales-order-pdf-C9QaiR37.js). vite.config.ts now writes the id into a <meta>
// in index.html instead, which no chunk hashes. buildId.test.ts pins that the
// source never compiles it in again.
//
// Same meaning as before for every reader: it is the build of the HTML this tab
// booted from, fixed for the life of the document.

export const BUILD_ID_META = "houzs-build-id";

export function readBuildId(doc: Document | undefined): string {
  const value = doc?.querySelector(`meta[name="${BUILD_ID_META}"]`)?.getAttribute("content")?.trim();
  return value ? value : "dev";
}

export const BUILD_ID = readBuildId(typeof document === "undefined" ? undefined : document);
