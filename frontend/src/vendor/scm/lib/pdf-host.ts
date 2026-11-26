// ----------------------------------------------------------------------------
// pdf-host — what a document generator needs from whoever RUNS it.
//
// The same layout code draws a document in two places: the browser (the ERP
// page's Print / PDF button) and the Worker (the AI Connector's get_pdf, which
// hands back a finished file). Layout must not fork between them — one copy of
// the drawing code is the whole point — so the few things that differ are asked
// of a host instead of imported:
//
//   letterhead()   the company block printed on the paper (branding text)
//   companyLogo()  the letterhead logo, already loaded; null = text-only
//   fontFace(url)  a Noto Sans SC subset face as base64 (the /fonts/*.ttf file)
//
// The browser registers its host in pdf-common.ts (branding cache + fetch on the
// page's own origin). The Worker registers one per render in
// backend/src/services/mcp-pdf.ts. Nothing in this file, or in pdf-core.ts and
// the *-render.ts modules that read it, may touch the DOM, React, or the api
// client: they are bundled into the Worker.
// ----------------------------------------------------------------------------

/** The company block a document prints. */
export type PdfLetterhead = {
  name: string;
  reg: string;
  addressLines: string[];
  phone: string;
  email: string;
  website: string;
  csPhone: string;
  csEmail: string;
  portalLabel: string;
};

/** An image jsPDF can embed as-is (structurally the same as branding.ts BrandingLogo). */
export type PdfLogo = {
  key: string;
  company?: string;
  dataUrl: string;
  format: 'PNG' | 'JPEG';
  width: number;
  height: number;
};

export type PdfHost = {
  letterhead(): PdfLetterhead;
  companyLogo(): PdfLogo | null;
  fontFace(url: string): Promise<string>;
};

let current: PdfHost | null = null;

export function setPdfHost(host: PdfHost | null): void {
  current = host;
}

export function pdfHost(): PdfHost {
  if (!current) throw new Error('No PDF host is registered: the document cannot be drawn here.');
  return current;
}
