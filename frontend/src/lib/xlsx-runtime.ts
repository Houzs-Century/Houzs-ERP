// Keep SheetJS lazy and expose only the browser operations HOUZS uses.  Importing
// the full module namespace at every call site prevents Rollup from dropping
// unrelated legacy format helpers from the on-demand export chunk.
export { read, utils, writeFileXLSX, writeXLSX } from 'xlsx';
