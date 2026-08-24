// Writes demo-statements/PBB-IBG-advice-Jun.pdf — a SYNTHETIC copy of the
// SHAPE of Public Bank's IBG payment advice (MAKLUMAN PEMBAYARAN), built to
// pair with demo-statements/PBB-2990HOME-Jun.csv:
//
//   the CSV's four transactions settle on 17 Jun 2026 across three EDC batches
//   and net RM 11,814.44 — so this advice prints those three batches, that one
//   settlement date, and that Grand Total. Upload the CSV on merchant
//   reconciliation, confirm it, upload this on the Payment advice tab, and the
//   day reads AGREES.
//
// No real number in it: the MID/TID are the CSV's own placeholders and the
// payee account is invented. The real advice is two pages; one page carries
// the same shape, and acc/pbb-advice.test.ts pins the two-page case.
//
// Regenerate with:  node scripts/make-demo-pbb-advice.mjs
// (from backend/; verify with the demo rig or acc/pbb-advice on the bytes)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'demo-statements', 'PBB-IBG-advice-Jun.pdf');

/** One positioned string, the way the real advice writes its cells. */
const cell = (x, y, text) => `1 0 0 1 ${x} ${y} Tm (${text.replace(/([()\\])/g, '\\$1')}) Tj`;

/* The header block sits in the right margin as label / colon / value cells;
   the batch table is anchored on its settlement-date column with the four
   money figures to the right — the exact positions acc/pbb-advice reads by. */
const content = [
  'BT', '/F1 8 Tf',
  cell(21, 800, 'MAKLUMAN PEMBAYARAN /'), cell(330, 800, 'PAYMENT ADVICE'),
  cell(21, 786, 'PUBLIC BANK BERHAD'),

  cell(330, 779, 'Nama Bank /'), cell(390, 779, 'Name of Bank'), cell(456, 779, ':'), cell(463, 779, 'MALAYAN BANKING BERHAD'),
  cell(330, 765, 'Nombor Akaun /'), cell(390, 765, 'Account Number'), cell(456, 765, ':'), cell(463, 765, '514012345678'),
  cell(330, 751, 'Jumlah Besar /'), cell(390, 751, 'Grand Total'), cell(456, 751, ':'), cell(463, 751, 'RM11,814.44'),
  cell(330, 737, 'Tarikh Penyata /'), cell(390, 737, 'Statement Date'), cell(456, 737, ':'), cell(463, 737, '19JUN26'),

  cell(76, 700, 'Merchant ID'), cell(131, 700, 'Terminal'), cell(181, 700, 'Batch'), cell(232, 700, 'Sett Date'),
  cell(321, 700, 'Gross'), cell(402, 700, 'Commission'), cell(485, 700, 'Deducted'), cell(547, 700, 'Net'),

  /* The CSV's three EDC batches of 17 Jun, and nothing else — the rows must
     reach the Grand Total to the sen or the reader refuses the whole file. */
  cell(76, 660, '9999999998'), cell(131, 660, '99999999'), cell(181, 660, '270429'), cell(232, 660, '17JUN26'),
  cell(321, 660, '1,620.00'), cell(402, 660, '8.10'), cell(485, 660, '0.00'), cell(547, 660, '1,611.90'),

  cell(76, 646, '9999999999'), cell(131, 646, '99999999'), cell(181, 646, '270430'), cell(232, 646, '17JUN26'),
  cell(321, 646, '945.00'), cell(402, 646, '8.03'), cell(485, 646, '0.00'), cell(547, 646, '936.97'),

  cell(76, 632, '9999999999'), cell(131, 632, '99999999'), cell(181, 632, '270431'), cell(232, 632, '17JUN26'),
  cell(321, 632, '9,345.00'), cell(402, 632, '79.43'), cell(485, 632, '0.00'), cell(547, 632, '9,265.57'),
  'ET',
].join('\n');

/* A minimal, uncompressed, unencrypted PDF — both the in-house reader and an
   ordinary viewer open it, so the operator can look at what he is uploading. */
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${out} (${pdf.length} bytes)`);
