// Read-only report: the existing damage behind the 2026-08-08 owner rulings —
// "为什么会有这样的 sku square pillow 你可以允许 freetext 的吗!?"
// (HC-SO-2607-013), HC-SO-2607-008 CONFIRMED with salesperson Unassigned and a
// bedframe line with no variant selections, and "venue is compulsory的".
//
// FOUR SECTIONS, each a shape the new guards now make impossible for NEW
// writes; this script lists the stragglers so the owner can decide fixes per
// line (each needs a HUMAN to pick the right SKU / salesperson / venue — there
// is deliberately NO auto-repair):
//   A. Non-cancelled SO lines whose item_code is BLANK or not in the SO's
//      company catalog (free-text lines like "Square pillow Col: BO315-22",
//      and scan-draft "Pick a product…" placeholders).
//   B. CONFIRMED-or-later orders with NO salesperson (salesperson_id NULL and
//      agent blank — the detail shows "Unassigned").
//   C. CONFIRMED-or-later orders with NO venue (venue blank and venue_id
//      NULL — the list shows "—").
//   D. CONFIRMED-or-later goods lines missing their category-required variant
//      axes (the confirm rule: colour-KIV satisfies the fabric axis — KIV
//      blocks the Processing Date, not confirm; sofa Leg Height is not
//      required — it defaults).
//   E. DRAFT orders carrying a Processing Date (owner addendum, 2990-SO-2608-
//      007: a draft has not started processing — the scan job used to pin
//      processing_date to the scan day; the fix stops the default, this
//      lists the rows it already stamped). The processing-date LOCK was
//      verified to ignore DRAFTs on both ends (soProcessingLocked /
//      procLockActive), so these rows mislead, they do not lock.
//
// Much of the visible damage is the test batch (addresses like "Jalan Test
// 4") — every row carries a TEST? hint so real orders stand out.
//
// Strictly ONE SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — clean AND dirty are both answers; only an unreachable
// database or a query error exits non-zero. Manual trigger only (see
// .github/workflows/so-noncatalog-lines.yml).
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

// `notice` surfaces the verdict on the workflow run's summary page.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* ── The confirm variant rule, ported from src/scm/shared/so-variant-rule.ts
   (missingConfirmVariantAxes) + variant-summary.ts (isColourKiv). Scripts are
   plain node and cannot import the TS — keep these three constants in
   lock-step with the source (they change together or not at all). */
const REQUIRED_AXES = {
  bedframe: [
    { key: "divanHeight", label: "Divan Height", aliases: ["divanHeight"] },
    { key: "legHeight",   label: "Leg Height",   aliases: ["legHeight"] },
    { key: "gap",         label: "Gap",          aliases: ["gap"] },
    { key: "fabricCode",  label: "Fabrics",      aliases: ["fabricCode", "colorCode", "colourCode", "fabricColor"] },
  ],
  sofa: [
    { key: "seatHeight",  label: "Seat Height",  aliases: ["seatHeight", "depth"] },
    // legHeight is required:false in the source — it always defaults.
    { key: "fabricCode",  label: "Fabrics",      aliases: ["fabricCode", "colorCode", "colourCode", "fabricColor"] },
  ],
};
const str = (v) => (v == null ? "" : String(v).trim());
const isColourKiv = (variants) => {
  if (!variants || typeof variants !== "object") return false;
  if (!(str(variants.fabricId) || str(variants.fabricLabel))) return false;
  return !(str(variants.fabricCode) || str(variants.colorCode) || str(variants.colourCode)
    || str(variants.colourLabel) || str(variants.fabricColor));
};
const missingConfirmAxes = (group, variants) => {
  const axes = REQUIRED_AXES[str(group).toLowerCase()];
  if (!axes) return [];
  const v = variants && typeof variants === "object" ? variants : {};
  const kiv = isColourKiv(v);
  return axes
    .filter((axis) => !(axis.key === "fabricCode" && kiv))
    .filter((axis) => axis.aliases.every((k) => str(v[k]) === ""))
    .map((axis) => axis.label);
};

const CONFIRMED_PLUS = (status) => {
  const s = str(status).toUpperCase();
  return s !== "" && s !== "DRAFT" && s !== "CANCELLED";
};

try {
  /* One statement. Every non-cancelled SO with the confirm-gate header facts,
     the test-batch hint, and its non-cancelled lines (each line carrying an
     in_catalog verdict against the SO's OWN company catalog — code is only
     unique per company; a company-less legacy header degrades to any-company,
     matching validateItemCodes). */
  const rows = await pg`
    SELECT so.doc_no,
           so.company_id,
           so.status,
           so.created_at,
           so.debtor_name,
           so.salesperson_id,
           NULLIF(TRIM(COALESCE(so.agent, '')), '')  AS agent,
           NULLIF(TRIM(COALESCE(so.venue, '')), '')  AS venue,
           so.venue_id,
           so.processing_date,
           so.so_date,
           (COALESCE(so.address1, '') ILIKE '%jalan test%'
             OR COALESCE(so.debtor_name, '') ILIKE '%test%') AS test_hint,
           COALESCE(l.lines, '[]'::jsonb) AS lines
      FROM scm.mfg_sales_orders so
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'line_no',  i.line_no,
                   'code',     i.item_code,
                   'descr',    i.description,
                   'grp',      i.item_group,
                   'qty',      i.qty,
                   'variants', i.variants,
                   'in_catalog',
                     EXISTS (
                       SELECT 1 FROM scm.mfg_products p
                        WHERE p.code = i.item_code
                          AND (so.company_id IS NULL OR p.company_id = so.company_id)
                     )
                 ) ORDER BY i.line_no NULLS LAST, i.created_at
               ) AS lines
          FROM scm.mfg_sales_order_items i
         WHERE i.doc_no = so.doc_no AND NOT i.cancelled
      ) l ON true
     WHERE so.status <> 'CANCELLED'
     ORDER BY so.created_at DESC`;

  const nonCatalog = [];   // { doc, status, company, test, lineNo, code, descr, qty }
  const noSalesperson = []; // { doc, status, company, test, customer }
  const noVenue = [];
  const badVariants = [];  // { doc, status, company, test, code, missing }
  const draftWithProc = []; // { doc, status, company, test, procDate, soDate }

  const ymd = (v) => (v == null ? "" : String(v).slice(0, 10));
  for (const r of rows) {
    const test = r.test_hint === true;
    const base = { doc: r.doc_no, status: str(r.status) || "?", company: r.company_id ?? "—", test };
    const lines = Array.isArray(r.lines) ? r.lines : [];
    if (str(r.status).toUpperCase() === "DRAFT" && r.processing_date != null) {
      draftWithProc.push({ ...base, procDate: ymd(r.processing_date), soDate: ymd(r.so_date) });
    }
    for (const ln of lines) {
      const code = str(ln.code);
      if (!code || ln.in_catalog !== true) {
        nonCatalog.push({
          ...base,
          lineNo: ln.line_no ?? "?",
          code: code || "(blank)",
          descr: str(ln.descr) || "(no description)",
          qty: ln.qty ?? "?",
        });
      }
    }
    if (!CONFIRMED_PLUS(r.status)) continue;
    if (r.salesperson_id == null && !r.agent) {
      noSalesperson.push({ ...base, customer: str(r.debtor_name) || "?" });
    }
    if (!r.venue && r.venue_id == null) {
      noVenue.push({ ...base, customer: str(r.debtor_name) || "?" });
    }
    for (const ln of lines) {
      const code = str(ln.code);
      if (!code) continue; // already in section A
      const missing = missingConfirmAxes(ln.grp, ln.variants);
      if (missing.length > 0) badVariants.push({ ...base, code, missing });
    }
  }

  const tag = (t) => (t ? "  [TEST?]" : "");
  const section = (title, items, fmt) => {
    console.log("=".repeat(76));
    console.log(title);
    console.log("=".repeat(76));
    if (items.length === 0) { console.log("  (none)"); return; }
    for (const it of items) console.log(fmt(it));
  };

  section(
    `A. Non-catalog lines on non-cancelled SOs — ${nonCatalog.length}`,
    nonCatalog,
    (x) => `  ${x.doc}  [${x.status}]  company ${x.company}  line ${x.lineNo}  code ${x.code}  qty ${x.qty}  "${x.descr}"${tag(x.test)}`,
  );
  section(
    `B. CONFIRMED+ orders with NO salesperson — ${noSalesperson.length}`,
    noSalesperson,
    (x) => `  ${x.doc}  [${x.status}]  company ${x.company}  customer "${x.customer}"${tag(x.test)}`,
  );
  section(
    `C. CONFIRMED+ orders with NO venue — ${noVenue.length}`,
    noVenue,
    (x) => `  ${x.doc}  [${x.status}]  company ${x.company}  customer "${x.customer}"${tag(x.test)}`,
  );
  section(
    `D. CONFIRMED+ lines with incomplete required variants — ${badVariants.length}`,
    badVariants,
    (x) => `  ${x.doc}  [${x.status}]  company ${x.company}  ${x.code}  missing: ${x.missing.join(", ")}${tag(x.test)}`,
  );
  section(
    `E. DRAFT orders carrying a Processing Date — ${draftWithProc.length}`,
    draftWithProc,
    (x) => `  ${x.doc}  company ${x.company}  processing ${x.procDate}${x.procDate === x.soDate ? " (= SO date — the scan job's old default)" : ""}${tag(x.test)}`,
  );
  console.log("=".repeat(76));

  const testCount = [...nonCatalog, ...noSalesperson, ...noVenue, ...badVariants, ...draftWithProc].filter((x) => x.test).length;
  const total = nonCatalog.length + noSalesperson.length + noVenue.length + badVariants.length + draftWithProc.length;
  if (total === 0) {
    notice("CLEAN — every non-cancelled SO line is a catalog SKU, every confirmed order has a salesperson, a venue and complete required variants, and no draft carries a Processing Date.");
  } else {
    notice(
      `${nonCatalog.length} non-catalog line(s), ${noSalesperson.length} confirmed order(s) without a salesperson, ` +
      `${noVenue.length} without a venue, ${badVariants.length} confirmed line(s) with incomplete variants, ` +
      `${draftWithProc.length} draft(s) carrying a Processing Date ` +
      `(${testCount} of ${total} rows look like the test batch). Each needs a human decision — no auto-repair exists for these.`,
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
