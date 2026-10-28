// Read-only report: the "SOURCE PO" column on the DO / SI lists shows some POs
// as `2990-PO-2607-009` and others as `PO-2607-002`. This says WHY, per batch.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// The rendering was ruled out by reading the code: the chip is
// `inventory_movements.batch_no` verbatim (resolveDoSourcePosForDos in
// scm/routes/delivery-orders-mfg.ts), and batch_no is `purchase_orders.po_number`
// verbatim (resolvePoBatchByItem in scm/routes/grns.ts). Nothing adds, strips or
// normalises a prefix anywhere on that path. So the difference is in the DATA,
// and which KIND of data difference it is can only be answered by production.
//
// Two possibilities, and they call for opposite responses:
//
//   (1) LEGITIMATE. Doc numbers are namespaced per company
//       (companyDocPrefix): the base company HOUZS mints BARE numbers and every
//       other company prefixes with its code. A bare `PO-2607-002` belonging to
//       company 1 alongside a `2990-PO-2607-009` belonging to company 2 is the
//       system working as designed, and nothing should change.
//
//   (2) A MINT GAP. companyDocPrefix returns "" whenever `companyCode` is
//       missing from the context — reconstructed / headless contexts do that
//       (see createDraftPosFromPicks). A 2990 PO minted through such a path
//       gets a BARE number while carrying company_id = 2. That is a real defect
//       and it is visible here as a bare po_number on a non-base company.
//
// The report prints, per distinct source-PO batch that DO OUT movements
// reference: the batch string, whether a purchase_orders row matches it exactly,
// that PO's company, and — for a bare batch — whether a `<code>-`-prefixed TWIN
// also exists (which is what makes rewriting the display unsafe: the two
// namespaces can both hold the same tail, so a rendered `2990-PO-2607-002` could
// name a DIFFERENT real document on the batch -> lot -> COGS trail).
//
// SELECTs only. No DDL, no writes, no transaction. Exits 0 for every legitimate
// answer — the ANSWER is the output; only an unreachable DB exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

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

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // Company codes, so a company_id can be reported as the prefix it would mint.
  let codeById = new Map();
  try {
    const cos = await pg`SELECT id, code FROM public.companies ORDER BY id`;
    codeById = new Map(cos.map((c) => [Number(c.id), String(c.code ?? "")]));
    notice(`companies: ${cos.map((c) => `${c.id}=${c.code}`).join(", ")}`);
  } catch {
    notice("companies master unreadable — company codes will print as ids only.");
  }
  // The BASE company mints bare numbers; every other company prefixes. Base is
  // the one whose code is HOUZS (companyDocPrefix's own rule), not "id 1".
  const baseIds = new Set(
    [...codeById.entries()].filter(([, c]) => c.toUpperCase() === "HOUZS").map(([id]) => id),
  );

  // Every distinct batch a DO OUT movement carries — exactly the set the Source
  // PO column can render. Cancelled DOs excluded: their chips are not shown.
  const batches = await pg`
    SELECT m.batch_no AS batch, count(*)::int AS movements
      FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id
     WHERE m.source_doc_type = 'DO'
       AND m.movement_type = 'OUT'
       AND m.batch_no IS NOT NULL
       AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
     GROUP BY m.batch_no
     ORDER BY m.batch_no`;

  notice(`distinct source-PO batches on live DO OUT movements: ${batches.length}`);
  if (batches.length === 0) {
    notice("Nothing to classify. Either no batched DO shipments exist yet, or the ledger is empty.");
    process.exit(0);
  }

  const names = batches.map((b) => String(b.batch));
  // Exact matches, plus every PO whose number ENDS with a bare batch (the twin
  // test). `LIKE '%-' || bare` is deliberately not anchored to a specific code:
  // a third company would otherwise be invisible here.
  const pos = await pg`
    SELECT po_number, company_id, status
      FROM scm.purchase_orders
     WHERE po_number = ANY(${names})
        OR po_number LIKE ANY(${names.filter((n) => !/^\d+-/.test(n)).map((n) => `%-${n}`)})`;
  const byNumber = new Map(pos.map((p) => [String(p.po_number), p]));

  const bareOnBase = [];
  const bareOnOther = [];
  const prefixed = [];
  const orphan = [];
  const twins = [];

  for (const b of batches) {
    const batch = String(b.batch);
    const isPrefixed = /^\d+-/.test(batch);
    const po = byNumber.get(batch);
    if (!po) {
      orphan.push({ batch, movements: b.movements });
      continue;
    }
    const cid = po.company_id == null ? null : Number(po.company_id);
    const code = cid == null ? null : codeById.get(cid) ?? null;
    const row = { batch, movements: b.movements, company_id: cid, code, status: po.status };
    if (isPrefixed) {
      prefixed.push(row);
    } else if (cid == null || baseIds.has(cid)) {
      bareOnBase.push(row);
    } else {
      bareOnOther.push(row);
    }
    if (!isPrefixed) {
      const twinNos = pos
        .map((p) => String(p.po_number))
        .filter((n) => n !== batch && n.endsWith(`-${batch}`));
      if (twinNos.length > 0) twins.push({ batch, twins: twinNos });
    }
  }

  notice("================ classification ================");
  notice(`  prefixed batches (e.g. 2990-PO-…)          : ${prefixed.length}`);
  notice(`  bare batches on the BASE company (HOUZS)   : ${bareOnBase.length}   -> CORRECT BY DESIGN`);
  notice(`  bare batches on a NON-BASE company         : ${bareOnOther.length}   -> MINT GAP if > 0`);
  notice(`  batches matching NO purchase order at all  : ${orphan.length}`);

  if (bareOnOther.length > 0) {
    notice("---- BARE NUMBER ON A NON-BASE COMPANY (the real defect, if any) ----");
    for (const r of bareOnOther) {
      notice(`  ${r.batch}  company_id=${r.company_id} (${r.code ?? "?"})  status=${r.status}  movements=${r.movements}`);
    }
    notice(
      "These POs carry a non-base company_id but a bare po_number, so they were " +
        "minted through a context with no companyCode. Do NOT rename them: " +
        "po_number is copied into inventory_movements.batch_no and inventory_lots.batch_no, " +
        "and renaming it orphans the batch -> lot -> COGS trail. Fix the mint path first.",
    );
  } else {
    notice(
      "No bare number sits on a non-base company. The mixed prefixes on the " +
        "Source PO column are two companies' namespaces, which is the designed behaviour.",
    );
  }

  if (twins.length > 0) {
    notice("---- COLLIDING TAILS — why the display must NOT be normalised ----");
    for (const t of twins) {
      notice(`  bare ${t.batch}  ALSO exists as: ${t.twins.join(", ")}`);
    }
    notice(
      "Stamping a company prefix onto these bare chips would name a DIFFERENT " +
        "existing purchase order. This is the concrete reason the labels are left verbatim.",
    );
  } else {
    notice("No bare batch has a prefixed twin today — but the namespaces still permit one.");
  }

  if (orphan.length > 0) {
    notice("---- BATCHES WITH NO MATCHING PURCHASE ORDER ----");
    for (const r of orphan.slice(0, 50)) {
      notice(`  ${r.batch}  movements=${r.movements}`);
    }
    if (orphan.length > 50) notice(`  … and ${orphan.length - 50} more`);
    notice(
      "A batch_no that matches no po_number is either a non-PO batch label or a " +
        "PO that was renumbered after shipping. Worth a look; not this report's verdict.",
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
