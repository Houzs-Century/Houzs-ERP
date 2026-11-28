
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { letterheadLogoKey } from "./branding";
import { bytesToBase64, pdfImageFromBytes } from "../lib/pdf-image";
import {
  drawGrnInto,
  drawPurchaseOrderInto,
  drawSalesInvoiceInto,
  drawSalesOrderInto,
  finalizePoPdf,
  letterheadFromBranding,
  makeSupplierDocLoaders,
  PDF_COMPRESS,
  poDisplayNumber,
  purchaseOrderPrintBundle,
  safeName,
  salesOrderPrintBundle,
  setPdfHost,
  type LetterheadBranding,
  type PdfHost,
  type PdfLogo,
  type PoPdfSources,
  type ProductCategory,
  type GrnPdfSources,
  type ScmJsonGetter,
  type SiPdfSources,
  type SoPdfSources,
} from "../lib/shared-pdf";

/** A read as the connector's user failed: the status and the sentence to show them. */
export class PdfReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly note: string,
  ) {
    super(message);
    this.name = "PdfReadError";
  }
}

export type PdfReader = {
  json<T>(apiPath: string): Promise<T>;
  bytes(apiPath: string): Promise<{ status: number; contentType: string; companyCode: string | null; body: Uint8Array }>;
  asset(path: string): Promise<Uint8Array>;
};

export type ServerPdf = { bytes: Uint8Array; filename: string; pages: number; ms: number };

const enc = encodeURIComponent;
const str = (v: unknown): string => (v == null ? "" : String(v).trim());

let tail: Promise<void> = Promise.resolve();

async function exclusive<T>(host: PdfHost, fn: () => Promise<T>): Promise<T> {
  const before = tail;
  let release: () => void = () => undefined;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await before;
  setPdfHost(host);
  try {
    return await fn();
  } finally {
    setPdfHost(null);
    release();
  }
}

async function readLogo(r: PdfReader, apiPath: string, key: string, company: string | null): Promise<PdfLogo | null> {
  const res = await r.bytes(apiPath);
  if (res.status !== 200) return null;
  if (company && res.companyCode && res.companyCode.toUpperCase() !== company.toUpperCase()) return null;
  const img = pdfImageFromBytes(res.body);
  if (!img) return null;
  return { key, company: company ?? undefined, dataUrl: img.dataUrl, format: img.format, width: img.w, height: img.h };
}

async function serverHost(r: PdfReader): Promise<PdfHost> {
  return (await serverLetterhead(r)).host;
}

async function serverLetterhead(r: PdfReader): Promise<{ host: PdfHost; branding: Record<string, unknown> }> {
  const got = await r.json<{ branding?: Record<string, unknown>; companyCode?: string }>("/api/branding");
  const b = got.branding ?? {};
  const companyCode = str(got.companyCode).toUpperCase();
  const branding: LetterheadBranding = {
    companyName: str(b.companyName ?? b.company_name),
    registrationNo: str(b.registrationNo ?? b.registration_no),
    address: str(b.address),
    postcode: str(b.postcode),
    phone: str(b.phone),
    email: str(b.email),
    website: str(b.website),
    csPhone: str(b.csPhone ?? b.cs_phone),
    csEmail: str(b.csEmail ?? b.cs_email),
  };
  const key = letterheadLogoKey({ logoR2Key: str(b.logoR2Key ?? b.logo_r2_key), printLogoR2Key: str(b.printLogoR2Key ?? b.print_logo_r2_key) });
  const usingPrintSlot = key !== "" && key === str(b.printLogoR2Key ?? b.print_logo_r2_key);
  const logo = key ? await readLogo(r, `/api/branding/logo?k=${enc(key)}${usingPrintSlot ? "&variant=print" : ""}`, key, companyCode || null) : null;
  const letterhead = letterheadFromBranding(branding, companyCode);
  return {
    host: {
      letterhead: () => letterhead,
      companyLogo: () => logo,
      fontFace: async (url) => bytesToBase64(await r.asset(url)),
    },
    branding: b,
  };
}

async function linePhoto(r: PdfReader, apiPath: string, fullKey: string): Promise<Blob> {
  const res = await r.bytes(apiPath);
  if (res.status !== 200) throw new Error(`photo ${res.status}`);
  if (fullKey.endsWith(".thumb") && !pdfImageFromBytes(res.body)) throw new Error("thumb not embeddable");
  return new Blob([res.body], { type: res.contentType || "application/octet-stream" });
}

const photoImage = async (blob: Blob) => pdfImageFromBytes(new Uint8Array(await blob.arrayBuffer()));

function finish(doc: jsPDF, filename: string, t0: number): ServerPdf {
  return { bytes: new Uint8Array(doc.output("arraybuffer")), filename, pages: doc.getNumberOfPages(), ms: Date.now() - t0 };
}

type SoArgs = Parameters<typeof drawSalesOrderInto>;
type PoArgs = Parameters<typeof drawPurchaseOrderInto>;

/** A Sales Order's PDF, made as the person (their reads, their money visibility). */
export async function salesOrderPdf(r: PdfReader, docNo: string): Promise<ServerPdf> {
  const t0 = Date.now();
  const getJson: ScmJsonGetter = (path) => r.json(`/api/scm${path}`);
  const bundle = await salesOrderPrintBundle(getJson, docNo);
  const host = await serverHost(r);
  const loaders = makeSupplierDocLoaders(getJson);
  const sources: SoPdfSources = {
    fabricDescriptionMap: (codes) => loaders.loadFabricDescriptionMap(codes),
    fabricSupplierMap: (codes) => loaders.loadFabricSupplierMap(codes),
    linePhoto: (doc, itemId, key) => linePhoto(r, `/api/scm/mfg-sales-orders/${enc(doc)}/items/${enc(itemId)}/photos/${enc(key)}`, key),
    photoImage,
    letterheadReady: async () => undefined,
    brandLogo: (key) => readLogo(r, `/api/projects/brands/logo?key=${enc(key)}`, key, null),
    productCategories: () =>
      getJson<{ categories?: ProductCategory[] }>("/mfg-products/categories").then(
        (res) => res.categories ?? [],
        (e: unknown) => {
          console.warn("[mcp-pdf] product categories not readable; headings read the code:", e instanceof Error ? e.message : String(e));
          return [];
        },
      ),
  };
  const header = bundle.header as unknown as SoArgs[3];
  return exclusive(host, async () => {
    const doc = new jsPDF({ ...PDF_COMPRESS, unit: "mm", format: "a4" });
    await drawSalesOrderInto(doc, autoTable, sources, header, bundle.items as unknown as SoArgs[4], (bundle.payments ?? []) as unknown as SoArgs[5], (bundle.pwpCodes ?? []) as unknown as SoArgs[6], undefined);
    return finish(doc, `${header.doc_no}-${safeName(header.debtor_name || "customer")}.pdf`, t0);
  });
}

/** A Purchase Order's PDF, made as the person (their reads, their money visibility). */
export async function purchaseOrderPdf(r: PdfReader, id: string): Promise<ServerPdf> {
  const t0 = Date.now();
  const getJson: ScmJsonGetter = (path) => r.json(`/api/scm${path}`);
  const bundle = await purchaseOrderPrintBundle(getJson, id);
  const host = await serverHost(r);
  const loaders = makeSupplierDocLoaders(getJson);
  const sources: PoPdfSources = {
    letterheadReady: async () => undefined,
    supplierDocData: (supplierId, items) => loaders.loadSupplierDocData(supplierId, items),
    linePhoto: (poId, itemId, key) => linePhoto(r, `/api/scm/mfg-purchase-orders/${enc(poId)}/items/${enc(itemId)}/photos/${enc(key)}`, key),
    photoImage: (blob) => photoImage(blob),
    sofaArt: async () => ({}),
  };
  const header = bundle.header as unknown as PoArgs[3];
  return exclusive(host, async () => {
    const doc = new jsPDF({ ...PDF_COMPRESS, unit: "mm", format: "a4" });
    const rendered = await drawPurchaseOrderInto(doc, autoTable, sources, header, bundle.items as unknown as PoArgs[4], undefined);
    finalizePoPdf(doc, [rendered]);
    return finish(doc, `${poDisplayNumber(header.po_number, header.revision)}-${safeName(rendered.supplierName)}.pdf`, t0);
  });
}

type SiArgs = Parameters<typeof drawSalesInvoiceInto>;
type GrnArgs = Parameters<typeof drawGrnInto>;

/** A Sales Invoice's PDF, made as the person: the detail read the ERP page prints from (`/api/scm/sales-invoices/:id`). */
export async function salesInvoicePdf(r: PdfReader, id: string): Promise<ServerPdf> {
  const t0 = Date.now();
  const getJson: ScmJsonGetter = (path) => r.json(`/api/scm${path}`);
  const got = await getJson<{ salesInvoice: Record<string, unknown>; items?: unknown[] }>(`/sales-invoices/${enc(id)}`);
  const { host, branding } = await serverLetterhead(r);
  const loaders = makeSupplierDocLoaders(getJson);
  const sources: SiPdfSources = {
    customerFabricMaps: (items) => loaders.loadCustomerFabricMaps(items),
    customerPaymentDetails: () => str(branding.customerPaymentDetails ?? branding.customer_payment_details),
  };
  const header = got.salesInvoice as unknown as SiArgs[3];
  return exclusive(host, async () => {
    const doc = new jsPDF({ ...PDF_COMPRESS, unit: "mm", format: "a4" });
    await drawSalesInvoiceInto(doc, autoTable, sources, header, (got.items ?? []) as unknown as SiArgs[4]);
    return finish(doc, `${header.invoice_number}-${safeName(header.debtor_name || "customer")}.pdf`, t0);
  });
}

/** A Goods Received Note's PDF, made as the person: the detail read the ERP page prints from (`/api/scm/grns/:id`). */
export async function grnPdf(r: PdfReader, id: string): Promise<ServerPdf> {
  const t0 = Date.now();
  const getJson: ScmJsonGetter = (path) => r.json(`/api/scm${path}`);
  const got = await getJson<{ grn: Record<string, unknown>; items?: unknown[] }>(`/grns/${enc(id)}`);
  const host = await serverHost(r);
  const loaders = makeSupplierDocLoaders(getJson);
  const sources: GrnPdfSources = { supplierDocData: (supplierId, items) => loaders.loadSupplierDocData(supplierId, items) };
  const header = got.grn as unknown as GrnArgs[3];
  return exclusive(host, async () => {
    const doc = new jsPDF({ ...PDF_COMPRESS, unit: "mm", format: "a4" });
    await drawGrnInto(doc, autoTable, sources, header, (got.items ?? []) as unknown as GrnArgs[4]);
    return finish(doc, `${header.grn_number}-${safeName(header.supplier?.name ?? "supplier")}.pdf`, t0);
  });
}
