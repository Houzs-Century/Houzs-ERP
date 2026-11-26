// ----------------------------------------------------------------------------
// mcp-pdf — the AI Connector's get_pdf for Sales Orders and Purchase Orders:
// the finished PDF file, drawn on the Worker by the SAME generator the ERP page
// runs in the browser (src/lib/shared-pdf.ts), not a second layout.
//
// Everything is read AS THE PERSON through the reader routes/mcp.ts hands in —
// the in-process GET with their own token, then the connector's credential and
// money strip — so the document is made from exactly the data that person's ERP
// login can see, and nothing is written except the R2 export object the caller
// stores. The data assembly is the browser's own (print-bundle.ts), so the
// payments-read-must-succeed rule and the warehouse lookup are the same too.
//
// What the Worker cannot do the way the browser does, and what it does instead
// (each one is a smaller file or a plainer picture, never a wrong figure):
//   · photos / logos: no canvas, so JPEG and PNG are embedded as they are and
//     WebP / GIF are left out (lib/pdf-image.ts). A WebP `.thumb` falls back to
//     the original key first.
//   · sofa compartment artwork on the PO: needs a canvas to crop, so every
//     module draws its schematic.
//   · the Chinese font: the same Noto Sans SC subsets, fetched from the site
//     (/fonts/*.ttf, public and immutable) and checked against the same cmap.
//
// ONE RENDER AT A TIME PER ISOLATE. The layout reads its letterhead from a
// module-level host (pdf-host.ts), so two concurrent renders for two companies
// must not interleave; `exclusive` queues them.
// ----------------------------------------------------------------------------

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { letterheadLogoKey } from "./branding";
import { bytesToBase64, pdfImageFromBytes } from "../lib/pdf-image";
import {
  drawPurchaseOrderInto,
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
  type ScmJsonGetter,
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
  /** GET an /api path as the person, parsed and stripped like every connector read. Throws PdfReadError. */
  json<T>(apiPath: string): Promise<T>;
  /** GET an /api path as the person, raw (photos, logos). Never throws on an HTTP status. */
  bytes(apiPath: string): Promise<{ status: number; contentType: string; companyCode: string | null; body: Uint8Array }>;
  /** A public file of the ERP site (the /fonts/*.ttf subsets). Throws when it cannot be fetched. */
  asset(path: string): Promise<Uint8Array>;
};

export type ServerPdf = { bytes: Uint8Array; filename: string; pages: number; ms: number };

const enc = encodeURIComponent;
const str = (v: unknown): string => (v == null ? "" : String(v).trim());

let tail: Promise<void> = Promise.resolve();

/** Run one render with `host` registered, after any render already in progress. A failed
 *  render still releases its turn (finally); its error goes to its own caller. */
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

/** An image route's bytes as a letterhead logo; null (text-only letterhead) on any failure, as in the browser. */
async function readLogo(r: PdfReader, apiPath: string, key: string, company: string | null): Promise<PdfLogo | null> {
  const res = await r.bytes(apiPath);
  if (res.status !== 200) return null;
  // The browser refuses bytes served for another company (lib/branding.ts); so does this.
  if (company && res.companyCode && res.companyCode.toUpperCase() !== company.toUpperCase()) return null;
  const img = pdfImageFromBytes(res.body);
  if (!img) return null;
  return { key, company: company ?? undefined, dataUrl: img.dataUrl, format: img.format, width: img.w, height: img.h };
}

/** The document company's letterhead + logo + font reader, as the person sees their branding. */
async function serverHost(r: PdfReader): Promise<PdfHost> {
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
    letterhead: () => letterhead,
    companyLogo: () => logo,
    fontFace: async (url) => bytesToBase64(await r.asset(url)),
  };
}

/** One line photo by its full key. A `.thumb` jsPDF cannot embed (WebP) is refused so the original is tried next. */
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
    // Fail-soft as in the browser: headings fall back to the Title Case code.
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
