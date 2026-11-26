// jsPDF lazily imports html2canvas / canvg / dompurify for doc.html() and SVG
// drawing, which the Worker never calls. wrangler.toml [alias] points those
// specifiers here so ~1 MB of browser-only code stays out of the bundle; a call
// that ever reaches one fails loudly instead of half-working.
const unavailable = (): never => {
  throw new Error("Not available on the Worker: jsPDF html / SVG rendering needs a browser.");
};
export default unavailable;
