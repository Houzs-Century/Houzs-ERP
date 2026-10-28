// ---------------------------------------------------------------------------
// line-photo-census.mjs — compare what the ACCOUNT BOOK holds against what we
// actually have on disk, as PURE functions: rows in, verdict out. No
// filesystem, no database, no network, no process.exit.
//
// ── WHY THIS IS NOT "read the manifest and count" ───────────────────────────
// Two separate bugs have already been paid for by treating one list as if it
// were another, and this module exists to keep them apart by name:
//
//   docs/bugs/0655  the export resumes at `DtlKey > checkpoint`. DtlKey is the
//                   identity of the LINE, not of the PICTURE — staff paste a
//                   drawing onto an order that already exists, so the line
//                   keeps its old low key. A resume is structurally incapable
//                   of finding that, and prints `new: 0` while missing it.
//                   => the book side of this comparison must come from a walk
//                      of the WHOLE key range, never from a checkpoint.
//
//   docs/bugs/0668  the attach step's authority was the MANIFEST, and a
//                   manifest row records what was DECODED — not what is on
//                   disk, and not what is in the bucket. Thirty addresses were
//                   written when twenty-one objects existed; nine live orders
//                   ended up showing a broken tile as their only picture.
//                   => a manifest row whose JPEG is absent is NOT held here.
//                      It is counted separately, as `manifestWithoutFile`.
//
// ── THE UNIT IS THE LINE ────────────────────────────────────────────────────
// One book line can carry several pictures (the PO side runs to five), and one
// book line is held in the ERP as several sofa compartment rows of which only
// the first carries the address. So "how many drawings does the book hold" is
// a count of LINES, and the picture total is reported beside it rather than
// instead of it. An instrument that cannot tell those apart reported "450
// missing" when the truth was 20.
// ---------------------------------------------------------------------------

/** The file name export-ac-line-photos.py writes for picture `n` of a line. */
export function pictureFileName(docNo, dtlKey, n) {
  return `${docNo}__${dtlKey}_${n}.jpg`;
}

/**
 * Compare the book against what we hold.
 *
 * @param bookLines     [{ DocNo, DtlKey, pics }]  — from a FULL key-range walk
 * @param manifestRows  [{ DocNo, DtlKey, file }]  — the side's manifest
 * @param filesOnDisk   Set<string> of JPEG basenames actually present
 *
 * @returns {{
 *   bookLines: number, bookPictures: number, heldLines: number,
 *   missing: Array<{DocNo,DtlKey,pics}>,          // we hold NONE of its pictures
 *   partial: Array<{DocNo,DtlKey,pics,have}>,     // we hold some but not all
 *   manifestWithoutFile: Array<{DocNo,DtlKey,file}>,
 *   manifestNotInBook: Array<{DocNo,DtlKey,file}>,
 * }}
 */
export function compareCensus({ bookLines = [], manifestRows = [], filesOnDisk = new Set() } = {}) {
  const lineKey = (doc, dtl) => `${doc}|${dtl}`;

  // A manifest row only counts once its JPEG is actually on disk (0668).
  const haveFiles = new Set();
  const manifestWithoutFile = [];
  for (const m of manifestRows) {
    if (filesOnDisk.has(m.file)) haveFiles.add(m.file);
    else manifestWithoutFile.push({ DocNo: m.DocNo, DtlKey: m.DtlKey, file: m.file });
  }

  const bookIndex = new Set(bookLines.map((b) => lineKey(b.DocNo, b.DtlKey)));

  let bookPictures = 0;
  let heldLines = 0;
  const missing = [];
  const partial = [];

  for (const b of bookLines) {
    const pics = Math.max(1, Number(b.pics) || 1);
    bookPictures += pics;
    let have = 0;
    for (let n = 1; n <= pics; n++) {
      if (haveFiles.has(pictureFileName(b.DocNo, b.DtlKey, n))) have++;
    }
    if (have === 0) missing.push({ DocNo: b.DocNo, DtlKey: b.DtlKey, pics });
    else if (have < pics) partial.push({ DocNo: b.DocNo, DtlKey: b.DtlKey, pics, have });
    else heldLines++;
  }

  // A manifest row the book no longer shows is REPORTED, never acted on: the
  // picture may have been removed from the line, or the document renumbered.
  // Deleting a JPEG on that evidence is not this module's call.
  const manifestNotInBook = [];
  const seen = new Set();
  for (const m of manifestRows) {
    const k = lineKey(m.DocNo, m.DtlKey);
    if (bookIndex.has(k) || seen.has(k)) continue;
    seen.add(k);
    manifestNotInBook.push({ DocNo: m.DocNo, DtlKey: m.DtlKey, file: m.file });
  }

  return {
    bookLines: bookLines.length,
    bookPictures,
    heldLines,
    missing,
    partial,
    manifestWithoutFile,
    manifestNotInBook,
  };
}

/**
 * The DTLKEY_FILE that export-ac-line-photos.py reads: `<side> <key>` rows.
 * That mode is the BOUNDED one — it reads only the named keys, in
 * parameterised IN chunks — which is why the census hands over keys rather
 * than telling anyone to run FORCE=1 against a live book (0655).
 */
export function missingDtlKeyFile({ so = [], po = [] } = {}) {
  const lines = [
    '# DtlKeys the census found in the book but not on disk.',
    '# Read by: DTLKEY_FILE=<this file> python backend/scripts/export-ac-line-photos.py',
  ];
  for (const r of so) lines.push(`so ${r.DtlKey}`);
  for (const r of po) lines.push(`po ${r.DtlKey}`);
  return lines.join('\n');
}
