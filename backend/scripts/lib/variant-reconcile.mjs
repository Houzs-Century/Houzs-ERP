/* variant-reconcile — the VARIANT half of check-ac-erp-reconcile.mjs.
 *
 * The owner, 2026-09-07, go-live day: "还有里面的variant 啊 col divan gap 等等 /
 * 所以你要拿目前的orders 去对比autocount的数据什么不一样".  The document-level
 * reconcile answers "is the line there, for the right quantity, at the right
 * price".  This answers the next question: is the THING the factory will build
 * the thing AutoCount says.
 *
 * WHAT IT IS AND IS NOT.  Everything here is PURE — no database, no filesystem,
 * no clock.  It takes one AutoCount Desc2 plus one ERP line's `variants` and
 * returns a per-axis verdict.  The checker owns the I/O and the reporting; this
 * owns the meaning of "different", so it can be unit-tested and so the meaning
 * lives in ONE place.
 *
 * ── IT RE-USES THE WRITERS' OWN DECODERS, IT DOES NOT PARSE ─────────────────
 * parse-bedframe.mjs, parse-sofa.mjs, fabric-colour-match.mjs,
 * bedframe-special-map.mjs and sofa-special-map.mjs are passed IN.  A second
 * copy of a Desc2 rule is this repo's most expensive recurring bug — the
 * bedframe parser had already drifted twice between the SO and PO importers,
 * and both variant-refresh scripts once rebuilt the parser from the importer's
 * SOURCE TEXT with new Function().  An audit that hand-parsed Desc2 would
 * measure its own regexes against production and call the difference a defect.
 *
 * ── THE TWO OWNER RULES THAT DECIDE WHAT COUNTS AS A DIFFERENCE ─────────────
 * 1. BLANK IS OK UNTIL AN ORDER IS PROCEEDED.  "还没proceed还没确认的就可以直接
 *    放空的" (2026-09-04).  A line on an unconfirmed order may legitimately
 *    carry no colour, no seat size, no compartments; the customer has not
 *    chosen.  So every verdict carries the line's `proceeded` flag and the
 *    checker splits every count by it.  Quoting the all-orders figure as the
 *    backlog has already wasted the owner's time twice — sofa compartments read
 *    as 141 when the work was 30, colour as 594 when the work was 54.
 * 2. A MIGRATION COPIES, IT NEVER COMPUTES.  "跟着 autocount 的 document 就对了"
 *    (2026-08-11).  Where the Desc2 says nothing about the leg, the ERP holding
 *    nothing is CORRECT.  BOOK-BLANK is therefore never a gap; it is reported
 *    on its own line because the owner asked to see it ("AutoCount blank but
 *    ERP has one"), not because it is work.
 *
 * ── THE VERDICTS ─────────────────────────────────────────────────────────
 *   AGREE        both sides say the same thing, or both say nothing.
 *   ERP_BLANK    the book states the axis and the ERP carries nothing.
 *                THE ONLY ONE THAT IS A GAP — and only on a proceeded order.
 *   BOOK_BLANK   the ERP carries a value the book never stated.  Not a gap:
 *                an operator filled it in, which is what the ERP is for.
 *   DIFFER       both present and NOT the same.  Always worth a human.
 *   PENDING      the book says TBC / KIV — the colour is not chosen yet.  Not
 *                blank and not a value; it is a third state and gets its own
 *                column so it cannot inflate ERP_BLANK.
 *   UNREADABLE   the decoder cannot read this Desc2 (parse-sofa returns
 *                conf "low", or the guard that keeps "(1 ELT / T + NA +2ER)" a
 *                placeholder fires).  A photograph job, never a data defect.
 *   RULED        sofa compartments only.  The owner read the slip HIMSELF and
 *                set the build against the book's own words, and the ERP holds
 *                exactly what he ruled.  「一律跟账本。除了sofa compartment而已啊」
 *                — the book decides everything EXCEPT the sofa build, which is
 *                his.  So the ERP is SUPPOSED to differ from the text here.
 *                It is NOT folded into AGREE, for the same reason RECORDED is
 *                not: the line genuinely does differ from the book, and hiding
 *                that would remove the only signal that would catch a ruling
 *                applied to the WRONG document.
 *                A ruling that has NOT been written stays DIFFER — that is the
 *                whole safety property.  On 2026-09-08 the owner ruled three
 *                builds, was shown a report still displaying the old values and
 *                said 「这个很多我刚刚都给过你答案了啊」.  Had this column existed,
 *                the two he had already been given would have read RULED and
 *                the one still unwritten would have stood out as the only work.
 *   RECORDED     specials only.  The book asks for a PRICED option, the line
 *                does not tick it, and `variants.specialsRecorded` carries it.
 *                That is the owner's ruling 甲 of 2026-09-03 already applied —
 *                「记下来给工厂看，但单据的钱不可以动」 — not an open gap.
 *
 * ── WHY RECORDED HAD TO BECOME ITS OWN VERDICT ─────────────────────────────
 * `record-priced-specials-on-migrated-lines.mjs` deliberately writes
 * `variants.specialsRecorded` and never `variants.specials`, because ten call
 * sites across nine files fold `variants.specials` into a price or a cost and
 * stamping it there would reprice a historical document.  `variant-summary.ts`
 * surfaces the recorded key, so the factory does see the option.
 *
 * This reader knew nothing about that column.  It read only `variants.specials`,
 * `variants.special` and `custom_specials`, so every line closed by the owner's
 * own money-neutral decision kept reporting as DIFFER — work already done,
 * counted as outstanding, on the eve of go-live.
 *
 * It is NOT folded into AGREE: the line genuinely does not carry the tick, and
 * pretending otherwise would be the same dishonesty pointing the other way.  It
 * gets its own column, so the open backlog and the decided-and-recorded set can
 * never be added up into one number again.
 *
 * ── COMPARTMENTS ARE A MULTISET ─────────────────────────────────────────────
 * "Piece ORDER does not matter: the apply script compares the compartment
 * MULTISET, because line_no is storage order, not physical layout"
 * (sofa-slip-notation).  Comparing by position would report every correctly
 * built sofa whose rows happen to be stored in another order.
 *
 * ── COLOUR IS COMPARED AS AN IDENTITY, NOT AS A SPELLING ────────────────────
 * Both sides are resolved through the ONE fabric matcher, which follows the
 * 2026-08-11 renumbering to the LIVE row.  Comparing the raw strings would
 * report "CH141-8" against "CH141-08" as a difference when they are the same
 * colour, and — the failure that actually happened, and cost 166 sofa lines
 * their colour — would let a DEAD library row answer for a live one.
 */

/* ── small readers ─────────────────────────────────────────────────────────── */

export const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
export const norm = (s) => txt(s).toUpperCase().replace(/\s+/g, " ");

/** First non-empty value among `keys` on a variants object. */
export const pickAxis = (variants, keys) => {
  const v = variants && typeof variants === "object" && !Array.isArray(variants) ? variants : {};
  for (const k of keys) {
    const x = txt(v[k]);
    if (x) return x;
  }
  return "";
};

/**
 * A height in inches, from any of the spellings the ERP stores.
 * The bedframe patch writes `8"`; the sofa backfill writes `32"`; rows written
 * before it wrote a bare `24`.  All three are the same number.
 */
export const inches = (v) => {
  const s = txt(v);
  if (!s) return null;
  /* ── THE ERP'S OWN WORD FOR ZERO LEGS ────────────────────────────────────
     "No Leg" is not a typo to tolerate. It is a first-class choice on the
     bedframe form, stored as that literal string: src/scm/shared/variant-summary
     matches /^NO\s*LEG$/ when it composes the Desc2, and normalizeInchValue
     returns it unchanged. Our write-back then sends AutoCount `NO LEG`, which
     parseBedframe reads back as 0 — so the two systems agreed and only this
     reader could not see it, reporting ERP_BLANK on a line that matched.

     THE MIGRATION WRITER NEVER PRODUCES IT, which is why it went unseen:
     bedframeVariants writes `bf.leg + '"'`, so a migrated zero leg is stored
     as `0"` and always read fine. Only a line entered or edited through the
     ERP's own form carries this string.

     ABSENT IS STILL NOT ZERO. TBC, KIV and blank keep answering null — a
     component nobody has picked stays unknown (docs/bugs/0732). This reads a
     DECISION that was made, not a silence. */
  if (/^no\s*legs?$/i.test(s)) return 0;
  const m = /^(\d+(?:\.\d+)?)/.exec(s.replace(/^[^\d]+/, ""));
  return m ? Number(m[1]) : null;
};

/**
 * custom_specials and variants.specials hold THREE shapes in production, and a
 * reader that assumes one measures the wrong thing.  The 2026-08-10 backfill
 * bound JSON.stringify(next) to a jsonb parameter and postgres.js encoded it
 * again, so those rows hold a jsonb STRING whose text is a JSON array.
 * Array.isArray sees nothing there.  Coerce so the payload can be MEASURED.
 */
export const asList = (v) => {
  if (Array.isArray(v)) return { list: v, wrapped: false };
  if (typeof v === "string" && v) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return { list: p, wrapped: true };
    } catch {
      /* a bare string payload */
    }
    return { list: [v], wrapped: true };
  }
  return { list: [], wrapped: false };
};

/** Some rows carry { label | description } objects rather than plain strings. */
export const elText = (el) => {
  if (el == null) return "";
  if (typeof el === "string") return el;
  if (typeof el === "object") {
    const v = el.label ?? el.description ?? el.name ?? el.value;
    return typeof v === "string" ? v : "";
  }
  return String(el);
};

/** The compartment suffix of a sofa SKU: "8051-1A(LHF)" -> "1A(LHF)". */
export const compartmentOf = (code) => {
  const c = norm(code);
  const dash = c.indexOf("-");
  return dash < 0 ? "" : c.slice(dash + 1);
};

/** The model of an item code, folded through the cutover's model aliases. */
export const modelOf = (code, alias) => {
  const c = norm(code);
  const dash = c.indexOf("-");
  const base = dash < 0 ? c : c.slice(0, dash);
  return (alias && alias[base]) || base;
};

const bag = (xs) => xs.map((x) => norm(x)).filter(Boolean).sort();

/** null when the two multisets agree; otherwise what each side is short of. */
export function multisetDiff(have, want) {
  const a = bag(have);
  const b = bag(want);
  if (a.join("|") === b.join("|")) return null;
  const left = [...a];
  const right = [...b];
  const miss = b.filter((x) => {
    const i = left.indexOf(x);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
  const extra = a.filter((x) => {
    const i = right.indexOf(x);
    if (i < 0) return true;
    right.splice(i, 1);
    return false;
  });
  return { miss, extra };
}

/* ── verdicts ──────────────────────────────────────────────────────────────── */

export const AGREE = "AGREE";
export const ERP_BLANK = "ERP_BLANK";
export const BOOK_BLANK = "BOOK_BLANK";
export const DIFFER = "DIFFER";
export const PENDING = "PENDING";
export const UNREADABLE = "UNREADABLE";
export const RECORDED = "RECORDED";
/* The owner's per-document sofa ruling, already applied. Its evidence lives in
   backend/scripts/data/sofa-compartment-corrections-*.json — the SAME files
   apply-sofa-compartment-corrections.mjs writes from, so the reporter and the
   writer can never disagree about what he ruled. A build held back in _held is
   deliberately absent from that set: it is a ruling we have NOT written, and it
   must keep reading DIFFER. */
export const RULED = "RULED";
/* NO_LINE_KEY — both sides state the SAME set of values for this axis on this
   document, and which of OUR rows answers which of the book's was the checker's
   own guess.  See foldGuessedPairing below for why that is a third state and
   not a difference. */
export const NO_LINE_KEY = "NO_LINE_KEY";
export const VERDICTS = [AGREE, ERP_BLANK, BOOK_BLANK, DIFFER, PENDING, UNREADABLE, RECORDED, RULED, NO_LINE_KEY];

/** The generic two-value comparison every scalar axis uses. */
export function verdictOf(bookVal, erpVal, same) {
  const b = bookVal !== null && bookVal !== undefined && bookVal !== "";
  const e = erpVal !== null && erpVal !== undefined && erpVal !== "";
  if (!b && !e) return AGREE;
  if (b && !e) return ERP_BLANK;
  if (!b && e) return BOOK_BLANK;
  return same(bookVal, erpVal) ? AGREE : DIFFER;
}

const sameNumber = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

/* ── the axes ──────────────────────────────────────────────────────────────── */

/**
 * The ERP variant keys each axis may live under, and which item group asks for
 * it.  Mirrored from variant-merge.mjs's OWNED_VARIANT_KEYS / OWNED_SOFA_KEYS
 * and variant-axes.mjs's alias lists — the keys the WRITERS write, so an axis
 * this reads is an axis something actually fills.
 */
export const AXES = [
  { key: "colour", label: "colour / fabric", groups: ["bedframe", "sofa"],
    erpKeys: ["fabricCode", "colorCode", "colourCode", "fabricColor", "colourId"] },
  { key: "divan", label: "divan height", groups: ["bedframe"], erpKeys: ["divanHeight"] },
  { key: "gap", label: "gap", groups: ["bedframe"], erpKeys: ["gap"] },
  { key: "leg", label: "leg height", groups: ["bedframe"], erpKeys: ["legHeight"] },
  { key: "totalHeight", label: "T.Heights", groups: ["bedframe"], erpKeys: ["totalHeight"] },
  { key: "seat", label: "seat size", groups: ["sofa"], erpKeys: ["seatHeight", "depth"] },
  { key: "compartments", label: "sofa compartments", groups: ["sofa"], erpKeys: [] },
  { key: "specials", label: "specials", groups: ["bedframe", "sofa"], erpKeys: [] },
];

export const AXIS_KEYS = AXES.map((a) => a.key);
const AXIS = Object.fromEntries(AXES.map((a) => [a.key, a]));

/** The groups this module models at all.  Everything else has no variant axes. */
export const VARIANT_GROUPS = new Set(["bedframe", "sofa"]);

/* ── decoding the book side ────────────────────────────────────────────────── */

/**
 * Re-derive what AutoCount's own Desc2 says, using the writers' decoders.
 *
 * `deps` carries them in rather than importing them, so this module stays pure
 * and a test can drive it with stubs:
 *   { parseBedframe, parseSofa, isPendingColour, findColour, knownColour,
 *     reclOf, modelAlias }
 *
 * `itemGroup` is REQUIRED and decides which decoder runs — a parameter that
 * decides something is never optional here (BUG CLASS optional-param-noop).
 */
export function decodeBook(deps, { desc2, itemGroup, itemCode }) {
  const d2 = txt(desc2);
  const group = txt(itemGroup).toLowerCase();
  const out = {
    group,
    desc2: d2,
    readable: true,
    pendingColour: false,
    colour: null,
    divan: null,
    gap: null,
    leg: null,
    totalHeight: null,
    seat: null,
    compartments: null,
    specials: [],
    why: [],
  };
  if (!VARIANT_GROUPS.has(group)) {
    out.readable = false;
    out.why.push(`item group "${group || "(none)"}" has no variant axes`);
    return out;
  }
  if (!d2) {
    /* No build text at all.  That is BOOK-BLANK on every axis, not unreadable:
       rule 2 says the ERP holding nothing here is correct. */
    return out;
  }
  out.pendingColour = deps.isPendingColour(d2);

  if (group === "bedframe") {
    const bf = deps.parseBedframe(d2);
    out.colour = bf.color ?? null;
    out.divan = bf.divan ?? null;
    out.gap = bf.gap ?? null;
    out.leg = bf.leg ?? null;
    /* The SAME expression buildBedframeVariantPatch uses, so this compares
       against what the writer would have written and not against a second
       opinion about what a total height is.

       ── AN UNDECIDED COMPONENT MAKES THE TOTAL UNKNOWN, NOT SMALLER ────────
       THE THIRD OF THE THREE COPIES of that rule, and the last one owed.
       `docs/bugs/0732` fixed lib/parse-bedframe.mjs and named this file and
       lib/variant-merge.mjs as still carrying the defect. Both are now fixed
       together, which is the only way this expression can go on being "the same
       expression the writer uses" — the whole reason it is spelled out here
       rather than imported.

       WHAT IT DOES TO THE VERDICT, and it is not a new difference: `verdictOf`
       returns BOOK_BLANK when the book states nothing and the ERP holds a
       value, so an affected line moves from AGREE to BOOK_BLANK — "the ERP
       carries a value the book never stated", which is what the book genuinely
       does for a bed whose divan nobody has picked. It stops the axis asserting
       agreement on a height nobody chose. It locks nothing and it writes
       nothing: BOOK_BLANK is a declared class, never a gap.

       A merely ABSENT component is untouched, and SELF_TEST's own case
       'Col: /Div:8"/M.GAP:14"' -> 22" is the pin that says so. */
    const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
    const heightPending = bf.divanPending === true || bf.gapPending === true || bf.legPending === true;
    out.totalHeight = heightPending ? null : tot || null;
    out.specials = Array.isArray(bf.specials) ? bf.specials : [];
    return out;
  }

  const model = modelOf(itemCode, deps.modelAlias);
  const ps = deps.parseSofa(d2, model, deps.reclOf(model), { knownColour: deps.knownColour });
  out.colour = ps.color ?? null;
  out.seat = ps.size ?? null;
  out.specials = Array.isArray(ps.specials) ? ps.specials : [];
  if (ps.conf === "low" || !ps.pieces.length) {
    /* The structure could not be read.  Colour, seat and specials that DID come
       out are still real answers, so only the compartment axis goes unreadable
       — reporting the whole line as unreadable would hide a colour gap behind a
       drawing problem. */
    out.compartments = null;
    out.why.push(...(ps.why || []));
  } else {
    out.compartments = ps.pieces;
  }
  return out;
}

/* ── comparing one line ────────────────────────────────────────────────────── */

/**
 * Compare one AutoCount line against the ERP line(s) it became.
 *
 * `erpLines` is an ARRAY because one AutoCount sofa line becomes one ERP line
 * per compartment.  The scalar axes are read off the LEAD line (they are
 * written identically to every piece of a build); the compartment axis is the
 * multiset over all of them.
 *
 * Returns { axes: { <key>: { verdict, book, erp, detail } }, proceeded }.
 */
export function compareLine(deps, { book, erpLines, proceeded, erpNo = null }) {
  const lead = erpLines[0] || {};
  const group = book.group;
  const axes = {};
  const applies = (a) => a.groups.includes(group);

  for (const a of AXES) {
    if (!applies(a)) continue;
    /* `bookId` / `erpId` are the CANONICAL forms the verdict was decided on —
       a colour as its library row, a height as its number — carried beside the
       display strings so foldGuessedPairing can compare two lines' values
       without re-deciding what "the same" means. They are set only on the
       SCALAR axes; compartments and specials are multisets already and are
       deliberately never folded (see foldGuessedPairing). */
    axes[a.key] = { verdict: AGREE, book: "", erp: "", detail: "", bookId: null, erpId: null };
  }
  if (!VARIANT_GROUPS.has(group)) return { axes, proceeded };

  /* colour — resolved to a library identity on both sides */
  if (axes.colour) {
    const erpRaw = pickAxis(lead.variants, AXIS.colour.erpKeys);
    const bookRaw = book.colour;
    const cell = axes.colour;
    cell.book = bookRaw || (book.pendingColour ? "(TBC/KIV)" : "");
    cell.erp = erpRaw;
    if (!bookRaw && book.pendingColour && !erpRaw) {
      cell.verdict = PENDING;
      cell.detail = "the book says the colour is not chosen yet";
    } else {
      const bId = bookRaw ? deps.colourIdentity(bookRaw) : null;
      const eId = erpRaw ? deps.colourIdentity(erpRaw) : null;
      /* The same fallback the equality below uses: a colour the library cannot
         resolve is still comparable to itself by its spelling, so two rows that
         name one unlisted fabric are not called different. */
      cell.bookId = bookRaw ? bId ?? `raw:${norm(bookRaw)}` : null;
      cell.erpId = erpRaw ? eId ?? `raw:${norm(erpRaw)}` : null;
      cell.verdict = verdictOf(bookRaw || null, erpRaw || null, () =>
        bId && eId ? bId === eId : norm(bookRaw) === norm(erpRaw),
      );
      if (cell.verdict === DIFFER) {
        cell.detail = `${bId ? `book -> ${bId}` : "book colour not in the library"}; ` +
          `${eId ? `ERP -> ${eId}` : "ERP colour not in the library"}`;
      } else if (cell.verdict === ERP_BLANK && book.pendingColour) {
        cell.verdict = PENDING;
        cell.detail = "the book names a colour AND marks it TBC/KIV; not chosen yet";
      }
    }
  }

  for (const [key, bookVal] of [
    ["divan", book.divan],
    ["gap", book.gap],
    ["leg", book.leg],
    ["totalHeight", book.totalHeight],
    ["seat", book.seat === null ? null : Number(book.seat)],
  ]) {
    const cell = axes[key];
    if (!cell) continue;
    const erpVal = inches(pickAxis(lead.variants, AXIS[key].erpKeys));
    cell.book = bookVal === null || bookVal === undefined ? "" : `${bookVal}"`;
    cell.erp = erpVal === null ? "" : `${erpVal}"`;
    cell.bookId = bookVal === null || bookVal === undefined || Number.isNaN(bookVal) ? null : String(Number(bookVal));
    cell.erpId = erpVal === null ? null : String(Number(erpVal));
    cell.verdict = verdictOf(
      bookVal === null || bookVal === undefined || Number.isNaN(bookVal) ? null : bookVal,
      erpVal,
      sameNumber,
    );
  }

  if (axes.compartments) {
    const cell = axes.compartments;
    const have = erpLines.map((l) => compartmentOf(l.item_code)).filter(Boolean);
    cell.erp = have.join("+");
    if (book.compartments === null) {
      cell.verdict = UNREADABLE;
      cell.book = "(cannot be read from Desc2)";
      cell.detail = book.why.join("; ");
      /* ── HIS DRAWING IS THE ONLY SOURCE HERE, SO ASK FOR IT ────────────────
         The book's text does not state the build, which is EXACTLY the case
         the owner's standing rule reserves for himself —
         「一律跟账本。除了sofa compartment而已啊」 — and so exactly the case where
         a ruling he has already given must be honoured. Until this branch
         asked, it never did: the ruling was consulted only where the book
         DECODED and the multiset differed, so every sofa he had personally
         read and answered whose text does not decode kept reporting as
         "CANNOT BE COMPARED — your drawing decides these", run after run.
         That is the report handing him back work he had already done, which he
         objected to three times on 2026-09-08:
         「这个很多我刚刚都给过你答案了啊」/「你不是会解析照片了吗？为什么还需要我呢」.

         THIS IS A NARROWING OF "WE COULD NOT TELL", NOT A WIDENING OF "IT
         MATCHES". Same lookup, same strictness as the DIFFER branch below:
         RULED requires the ERP to hold his answer as an EXACT multiset, a
         ruling in the corrections files' `_held` list is excluded by
         makeSofaRulingLookup, and a ruling the ERP has NOT been moved to
         leaves the cell UNREADABLE — still locking — while naming the answer
         it is failing to match, so nobody can act on it as if it were done.
         The permissive answer stays unreachable for a build nothing decided. */
      const ruling = erpNo && deps.sofaRuling ? deps.sofaRuling(erpNo, erpLines) : null;
      if (ruling && Array.isArray(ruling.pieces) && ruling.pieces.length && have.length) {
        if (!multisetDiff(have, ruling.pieces)) {
          cell.verdict = RULED;
          cell.detail = "the owner ruled this build " + ruling.pieces.join("+") +
            " from the drawing" + (ruling.source ? " (" + ruling.source + ")" : "") +
            " and the ERP holds it, so the book's silence is answered BY DECISION";
        } else {
          cell.detail += " | the owner ruled " + ruling.pieces.join("+") +
            " and the ERP does NOT hold it";
        }
      }
    } else {
      cell.book = book.compartments.join("+");
      const d = multisetDiff(have, book.compartments);
      if (!d) cell.verdict = AGREE;
      else if (!have.length) cell.verdict = ERP_BLANK;
      else {
        cell.verdict = DIFFER;
        cell.detail =
          (d.miss.length ? `MISSING ${d.miss.join(", ")}` : "") +
          (d.miss.length && d.extra.length ? " | " : "") +
          (d.extra.length ? `EXTRA ${d.extra.join(", ")}` : "");
        /* THE OWNER MAY HAVE ALREADY ANSWERED THIS ONE. Consulted ONLY on a
           difference that is otherwise real: a ruling can never turn an AGREE
           or an ERP_BLANK into something else, and it is asked AFTER the
           multiset has spoken, so the book comparison is never skipped.
           RULED requires the ERP to hold his answer EXACTLY. A ruling that has
           not been written, or written onto the WRONG document, still reads
           DIFFER — and now names whose answer it is failing to match, which is
           the line that would have caught HC-SO-013327 holding 1NA while his
           ruling said 1B(RHF). */
        const ruling = erpNo && deps.sofaRuling ? deps.sofaRuling(erpNo, erpLines) : null;
        if (ruling && Array.isArray(ruling.pieces) && ruling.pieces.length) {
          if (!multisetDiff(have, ruling.pieces)) {
            cell.verdict = RULED;
            cell.detail = "the owner ruled this build " + ruling.pieces.join("+") +
              " from the drawing" + (ruling.source ? " (" + ruling.source + ")" : "") +
              " and the ERP holds it, so it differs from the book's words BY DECISION";
          } else {
            cell.detail += " | the owner ruled " + ruling.pieces.join("+") +
              " and the ERP does NOT hold it";
          }
        }
      }
    }
  }

  if (axes.specials) {
    const cell = axes.specials;
    /* variants.specials is the INPUT the picker binds to.  custom_specials is
       DERIVED from it and is set to null whenever variants.specials is empty,
       so a line carrying only custom_specials is one edit away from losing it.
       Both are read so the line is not called blank when the data is present,
       and the checker counts the derived-only case separately. */
    const vs = asList((lead.variants || {}).specials);
    const vs1 = asList((lead.variants || {}).special);
    const cs = asList(lead.custom_specials);
    const carried = [...vs.list, ...vs1.list, ...cs.list].map(elText).filter(Boolean);
    /* The owner's ruling 甲 lives in its OWN key, on purpose: stamping a priced
       code into `variants.specials` would reprice a historical document, so
       record-priced-specials-on-migrated-lines.mjs writes `specialsRecorded`
       instead and variant-summary.ts shows it to the factory.  Read separately
       and NEVER merged into `carried`: a recorded option is not a ticked one. */
    const recorded = asList((lead.variants || {}).specialsRecorded).list.map(elText).filter(Boolean);
    const wanted = deps.mapSpecials(book.specials, group);
    cell.book = book.specials.join(" | ");
    cell.erp = carried.join(" | ");
    cell.detail = vs.list.length || vs1.list.length ? "" : cs.list.length ? "carried ONLY in the derived custom_specials" : "";
    if (!book.specials.length) {
      cell.verdict = carried.length ? BOOK_BLANK : AGREE;
    } else if (!carried.length && !recorded.length) {
      cell.verdict = ERP_BLANK;
    } else {
      const missing = wanted.filter((w) => !deps.specialCarried(w, carried));
      if (!missing.length) cell.verdict = AGREE;
      else {
        /* Every still-missing option is already recorded money-neutrally =>
           RECORDED, the decision applied.  A PARTIAL cover stays DIFFER: some
           of what the book asks for is neither ticked nor recorded, and
           rounding that up to "decided" is how a real gap disappears. */
        const unrecorded = missing.filter((w) => !deps.specialCarried(w, recorded));
        if (!unrecorded.length) {
          cell.verdict = RECORDED;
          cell.detail =
            `${cell.detail ? `${cell.detail}; ` : ""}the book asks for ${missing.join(", ")}; the line does not tick it and ` +
            "variants.specialsRecorded carries it — owner ruling 甲 2026-09-03, recorded for the factory with the document's money untouched";
        } else {
          cell.verdict = DIFFER;
          cell.detail =
            `${cell.detail ? `${cell.detail}; ` : ""}the book asks for ${unrecorded.join(", ")} and the line does not carry it` +
            (missing.length > unrecorded.length
              ? ` (${missing.length - unrecorded.length} more of what it asks for IS recorded money-neutrally)`
              : "");
        }
      }
    }
  }

  return { axes, proceeded };
}

/* ── the pairing the checker had to GUESS ──────────────────────────────────── */

/** The scalar axes a guessed pairing can transpose. Compartments and specials
 *  are deliberately absent: each is already a MULTISET over one line, so
 *  folding a second multiset over a bucket of lines would compare two things
 *  that are not the same shape, and the compartment axis has its own, stricter
 *  rule (an unkeyed sofa is UNREADABLE, never AGREE). */
export const FOLDABLE_AXES = ["colour", "divan", "gap", "leg", "totalHeight", "seat"];

/**
 * Reclassify the DIFFERs that only an ARBITRARY pairing could have produced.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `check-ac-erp-reconcile.mjs` pairs a book line to an ERP row on
 * `linked_ac_dtlkey` where the ERP carries one, and otherwise GUESSES: it falls
 * back to (quantity, unit price) and then to document order. A migrated
 * delivery order carries no money at all, so two rows of one product at one
 * quantity are indistinguishable and the assignment is decided by an ordering
 * the two systems do not share — the book's `Seq`, ours `(line_no, created_at,
 * id)`. Two values into two slots by an unshared ordering: a "swap" is what
 * that looks like half the time, and this repo has now been shown six of them
 * and five were phantoms (docs/bugs/0672, 0688, 0689, 0695, 0696, 0709).
 *
 * The document-level reconcile ALREADY declares this class on the item-code
 * axis, in the owner's own table, as `same-goods`: "we hold NO AutoCount line
 * number on these rows, so which of our lines answers which of the book's was
 * the checker's own guess." The variant axes trusted a pairing the axis above
 * them had publicly declared untrustworthy. This is that declaration, applied
 * one section down.
 *
 * ── THE RULE, AND WHY EACH CLAUSE IS THERE ────────────────────────────────
 * Per (document bucket, axis), a DIFFER becomes NO_LINE_KEY only when ALL of:
 *
 *   1. at least TWO of the bucket's rows carry no AutoCount line key.
 *      ONE unkeyed row among keyed ones is not a guess — the keyed rows are
 *      fixed and the last one is forced by elimination.
 *   2. the bucket holds more than one row. A single row cannot be transposed
 *      with anything.
 *   3. the two sides' value MULTISETS for that axis are EQUAL. This is the
 *      whole guarantee and it needs no pairing: a bag is order-independent, so
 *      no ordering can fake it and none can hide a real difference behind it.
 *      A bucket whose bags differ keeps every one of its DIFFERs — a PARTIAL
 *      cover is not a cover (the lesson of docs/bugs/0668, where a hand-typed
 *      label printed 30 real gaps as owner decisions).
 *
 * NO_LINE_KEY is NOT folded into AGREE, for the same reason RECORDED was not:
 * the row genuinely does not state what the book's row states, and pretending
 * otherwise is the same dishonesty pointing the other way. What is proven is
 * that the DOCUMENT ships the right values; which of our rows is which is
 * unknown, and is printed as unknown.
 *
 * PURE: cells in, cells mutated in place, nothing else. No I/O, no clock.
 *
 * @param {Array<{bucket: string, keyed: boolean, axes: Record<string, {verdict: string, bookId: ?string, erpId: ?string}>}>} entries
 * @returns {{folded: number, buckets: number}} what it changed, for the report
 */
export function foldGuessedPairing(entries) {
  const byBucket = new Map();
  for (const e of entries) {
    if (!byBucket.has(e.bucket)) byBucket.set(e.bucket, []);
    byBucket.get(e.bucket).push(e);
  }
  let folded = 0;
  const touched = new Set();
  for (const [bucket, es] of byBucket) {
    if (es.length < 2) continue;
    if (es.filter((e) => !e.keyed).length < 2) continue;
    for (const axis of FOLDABLE_AXES) {
      const cells = es.map((e) => e.axes[axis]).filter(Boolean);
      if (cells.length !== es.length) continue; // the axis does not apply to every row here
      if (!cells.some((c) => c.verdict === DIFFER)) continue;
      const bookBag = cells.map((c) => c.bookId ?? "(blank)").sort();
      const erpBag = cells.map((c) => c.erpId ?? "(blank)").sort();
      if (bookBag.join("") !== erpBag.join("")) continue;
      for (const c of cells) {
        if (c.verdict !== DIFFER) continue;
        c.verdict = NO_LINE_KEY;
        c.detail =
          `${c.detail ? `${c.detail}; ` : ""}this document's rows of this item carry NO AutoCount line key, so which of ` +
          `ours answers which of the book's is the checker's own guess — and both sides state the SAME set ` +
          `(${bookBag.join(", ")}), which no ordering can fake`;
        folded += 1;
        touched.add(bucket);
      }
    }
  }
  return { folded, buckets: touched.size };
}

/* ── the self-test ─────────────────────────────────────────────────────────── */

/**
 * "A checker that cannot match reports a clean run" is this repo's own named
 * failure, and its rule is: every checker proves its patterns at startup and
 * REFUSES rather than reporting from a dead one.
 *
 * Each case is a real Desc2 shape with the answer measured from the decoders on
 * 2026-09-07, not an answer invented here.  If a decoder is swapped, moved or
 * silently stops matching, one of these stops holding and the checker exits
 * before it can report a clean variant reconcile.
 *
 * EVERY CASE MUST DECODE THE SAME WITH `recl` TRUE AND FALSE.  The checker
 * derives `recl` from the LIVE product master (does this model have a recliner
 * SKU), so a case that answered differently under the two would fail or pass by
 * whatever `scm.mfg_products` happens to hold — a self-test whose verdict comes
 * from production data cannot prove the decoder.  Both sofa cases below were
 * measured both ways on 2026-09-07 and are identical; 8050 DOES carry
 * `8050-1S(R)`, so `reclOf` really does answer true for it.
 */
export const SELF_TEST = [
  {
    what: "bedframe: colour, divan, leg and gap all stated",
    desc2: "PC151-01/8inch+4inchLeg/Gap12inch",
    itemGroup: "bedframe",
    itemCode: "CODY-(SS)",
    expect: { colour: "PC151-01", divan: 8, leg: 4, gap: 12, totalHeight: 24 },
  },
  {
    what: "bedframe: curly quotes as inch markers, colour marked KIV",
    desc2: 'Divan:8”+4”leg/Gap:14”/Col:KIV',
    itemGroup: "bedframe",
    itemCode: "TRION (A)-(K)",
    expect: { colour: null, divan: 8, leg: 4, gap: 14, totalHeight: 26 },
  },
  {
    what: "bedframe: a divan stated with NO leg mentioned means leg 0, not unknown",
    desc2: 'Col: /Div:8"/M.GAP:14"',
    itemGroup: "bedframe",
    itemCode: "CELENE (A)-(Q)",
    expect: { colour: null, divan: 8, leg: 0, gap: 14, totalHeight: 22 },
  },
  {
    what: "sofa: a five-piece L with a corner, seat size and colour",
    desc2: '1EL+1NA+C+1NA+1ER/32"/Col:BO315-21',
    itemGroup: "sofa",
    itemCode: "8050-1A(LHF)",
    expect: {
      colour: "BO315-21",
      seat: "32",
      compartments: ["1A(LHF)", "1NA", "CNR", "1NA", "1A(RHF)"],
    },
  },
  {
    what: "sofa: the guard that keeps an unreadable build a placeholder must still fire",
    desc2: "(1 ELT / T + NA +2ER)",
    itemGroup: "sofa",
    itemCode: "5526-1S",
    expect: { compartments: null },
  },
];

/** Runs SELF_TEST against the real decoders. Returns the problems it found. */
export function runSelfTest(deps) {
  const problems = [];
  for (const c of SELF_TEST) {
    let got;
    try {
      got = decodeBook(deps, { desc2: c.desc2, itemGroup: c.itemGroup, itemCode: c.itemCode });
    } catch (e) {
      problems.push(`${c.what}: the decoder threw — ${e.message}`);
      continue;
    }
    for (const [k, want] of Object.entries(c.expect)) {
      const have = got[k];
      const same = Array.isArray(want)
        ? Array.isArray(have) && want.length === have.length && want.every((x, i) => norm(x) === norm(have[i]))
        : want === null
          ? have === null
          : typeof want === "number"
            ? Number(have) === want
            : norm(have) === norm(want);
      if (!same) {
        problems.push(
          `${c.what}: axis "${k}" decoded as ${JSON.stringify(have)}, expected ${JSON.stringify(want)} ` +
            `(Desc2 ${JSON.stringify(c.desc2)})`,
        );
      }
    }
  }
  return problems;
}
