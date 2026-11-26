
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
