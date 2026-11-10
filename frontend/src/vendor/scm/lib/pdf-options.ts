/* Spread into the options of EVERY jsPDF the app constructs. jsPDF writes page content streams
   uncompressed unless told otherwise, so a text-and-table document was several
   times larger than it needed to be — on the phone, on WhatsApp and against the
   5 MB PO email cap. Measured on a sample batch in pdf-options.test.ts. */
export const PDF_COMPRESS = { compress: true } as const;
