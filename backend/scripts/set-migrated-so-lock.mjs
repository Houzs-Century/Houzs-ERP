#!/usr/bin/env node
/* set-migrated-so-lock — open (or re-close) MIGRATED sales orders for staff, by
 * writing `scm.app_config['scm.migrated_so_lock']`. Takes effect within ~30s,
 * no deploy: the middleware caches the row for that long, per isolate.
 *
 * WHY IT EXISTS. Exactly the gap docs/bugs/0710 found in the write freeze, one
 * row along. `docs/migrated-so-lock.md` §6 and §10 both end in a raw SQL
 * `UPDATE` left for a person, and CLAUDE.md's standing rule is that the owner
 * is not a database console. This row decides whether ~2,900 documents can be
 * edited by the people who have to proceed them, so it deserves a plan step, a
 * confirm phrase and a printed before/after far more than a paste does.
 *
 * RUN IT WITH `npx tsx`, NOT `node`. It imports the REAL parser out of
 * `src/scm/lib/migrated-so-lock.ts` — the module the middleware itself reads —
 * because docs/bugs/0710's first lesson is that a setter must never carry a
 * second copy of the parse. The grammar is that file's, not this one's,
 * including what a malformed remainder does.
 *
 * THE DANGEROUS DIRECTION HERE IS **OPENING**, and that is the opposite of the
 * write freeze, where it is closing. The owner's ruling on 2026-09-08 was
 * 「只开新单，旧单暂时不能改」 — migrated orders shut — and the two live risks
 * behind it (sync-ac-delta overwriting a staff edit; AutoCount payments that
 * have never reached the ERP) are risks to DATA, which a re-close cannot undo.
 * So an apply that opens documents is REFUSED unless `ALLOW_OPEN=yes` says so
 * out loud. Closing is printed just as loudly but is not gated: taking editing
 * away is visible to staff within a minute and costs nobody their work.
 *
 *   DATABASE_URL   required
 *   MODE           plan (default) | apply
 *   VALUE          the value to store. The grammar is migrated-so-lock.ts's:
 *                    off / 0 / false / ''   migrated orders EDITABLE everywhere
 *                    all / true             locked for every company
 *                    1 / 1,2                locked for those companies
 *                    verdict:1 / verdict:all  CORRECTNESS mode — locked only
 *                                           while the published reconcile
 *                                           verdict is not `clean`
 *   CONFIRM        on apply, must equal "SET MIGRATED SO LOCK"
 *   ALLOW_OPEN     "yes" to permit an apply that OPENS documents
 *   MESSAGE        optional. The sentence staff see on a locked order — it
 *                  lives in `app_config.description`, not in the value.
 *                  OMITTED LEAVES THE EXISTING ONE ALONE, which is why the
 *                  write names its columns instead of upserting a whole row.
 *                  NOTE: `verdict:` mode does NOT consult it (the refusal must
 *                  name the document and the axis), so setting it there is
 *                  writing a sentence nobody will read.
 *
 * RE-RUN: idempotent. A second run with the same VALUE reads the row, finds it
 * already equal, writes nothing and says so. It is a SET, not a toggle.
 *
 * REVERSAL: re-run with the PREVIOUS value, which every run prints in full and
 * in the exact syntax this script accepts. Nothing else has to be undone — no
 * document changes and no schema changes. This row is a predicate, not data.
 */
import postgres from "postgres";
import {
  parseMigratedSoLock,
  migratedSoIsLocked,
  VERDICT_PREFIX,
} from "../src/scm/lib/migrated-so-lock.ts";

const KEY = "scm.migrated_so_lock";
const CONFIRM_PHRASE = "SET MIGRATED SO LOCK";

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);
const myt = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour12: false }) : "-");

/* EXERCISE THE REAL PARSE BEFORE ANYTHING ELSE — docs/bugs/0711 in one block.
   The freeze setter's first production dispatch died inside the shared library
   on its second line, and nothing local reached that line because every local
   gate exits before opening a database. So the contract is asserted at startup,
   with no DSN and no network, on the values the runbook actually documents. Get
   this wrong and you get a sentence, not a TypeError from inside another
   module. */
function assertParserContract() {
  const want = [
    ["off", "off", false, false],
    ["", "off", false, false],
    ["1", "[1]", false, false],
    ["1,2", "[1,2]", false, false],
    ["all", "all", false, false],
    ["verdict:1", "[1]", false, true],
    ["verdict:all", "all", false, true],
    ["1 - scm.sales.orders", "all", true, false],
    ["verdict:houzs", "all", true, false],
  ];
  const shape = (s) => (Array.isArray(s) ? `[${s.join(",")}]` : String(s));
  const bad = [];
  for (const [raw, scope, malformed, byVerdict] of want) {
    let got;
    try { got = parseMigratedSoLock(raw); } catch (e) { bad.push(`${JSON.stringify(raw)} threw ${e}`); continue; }
    if (shape(got.scope) !== scope || got.malformed !== malformed || got.byVerdict !== byVerdict) {
      bad.push(`${JSON.stringify(raw)} -> scope=${shape(got.scope)} malformed=${got.malformed} byVerdict=${got.byVerdict}`
        + `, expected scope=${scope} malformed=${malformed} byVerdict=${byVerdict}`);
    }
  }
  if (typeof migratedSoIsLocked !== "function" || VERDICT_PREFIX !== "verdict:") {
    bad.push(`the module's exports changed: VERDICT_PREFIX=${JSON.stringify(VERDICT_PREFIX)}`);
  }
  if (bad.length) {
    console.error("REFUSED — src/scm/lib/migrated-so-lock.ts no longer answers what this script assumes:");
    for (const b of bad) console.error(`  ${b}`);
    console.error("Fix the script against the module, never the other way round: the module is what the");
    console.error("middleware reads, and this script exists to write a value that module will honour.");
    process.exit(1);
  }
  /* Said out loud on the PASS as well, because docs/bugs/0711's whole finding
     was that nobody could tell the parse had never been exercised. A silent
     success is indistinguishable from a check that did not run. */
  log(`PARSER CONTRACT OK — ${want.length} values through src/scm/lib/migrated-so-lock.ts`);
}
assertParserContract();

/* EVERYTHING PARSEABLE IS VALIDATED BEFORE THE DSN IS EVEN LOOKED FOR. That
   ordering is the fix for docs/bugs/0711: a local run with no database still
   reaches every line of the grammar, so a bad value is refused on a laptop
   instead of in a workflow. */
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
if (MODE !== "plan" && MODE !== "apply") {
  console.error(`MODE must be plan or apply, got ${JSON.stringify(MODE)}`); process.exit(1);
}
const ALLOW_OPEN = (process.env.ALLOW_OPEN || "").trim().toLowerCase() === "yes";
const CONFIRM = process.env.CONFIRM ?? "";
const RAW_MESSAGE = process.env.MESSAGE ?? "";
const MESSAGE = RAW_MESSAGE.trim() === "" ? null : RAW_MESSAGE.trim();

/* VALUE is REQUIRED and has no default, deliberately. Every default this row
   could carry is somebody's production state: 'off' opens 2,900 documents the
   owner ruled shut, '1' shuts them. A switch whose setter has a favourite is a
   switch that gets set by accident. */
if (process.env.VALUE === undefined) {
  console.error("VALUE not set. Pass the value to store — off / all / '1' / '1,2' / verdict:1 / verdict:all.");
  console.error("There is no default: every possible default is somebody's production state.");
  process.exit(1);
}
const TARGET = String(process.env.VALUE).trim();

const parsedAfter = parseMigratedSoLock(TARGET);
if (parsedAfter.malformed) {
  console.error(`REFUSED — ${JSON.stringify(TARGET)} is not a value this row's grammar admits.`);
  console.error("  It would be stored, and the middleware would read it as 'all' — every migrated order");
  console.error("  of every company shut — which is almost never what somebody typing a typo meant.");
  console.error("  Accepted: off / 0 / false / '' | all / true | 1 | 1,2 | verdict:1 | verdict:all");
  console.error("  A `-` is refused on purpose: that grammar belongs to scm.write_freeze, one row along.");
  process.exit(1);
}

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

/** open (0) < by-verdict (1) < shut (2) — how tightly ONE company is held. */
function stateFor(v, companyId) {
  const locked = migratedSoIsLocked(v, companyId, true, null);
  if (!locked) return "open";
  return v.byVerdict ? "by-verdict" : "shut";
}
const RANK = { open: 0, "by-verdict": 1, shut: 2 };

const describe = (v) => {
  if (v.scope === "off") return "nothing locked — every migrated order is editable";
  const who = v.scope === "all" ? "every company" : `company ${v.scope.join(", ")}`;
  return v.byVerdict
    ? `${who}: a migrated order is locked only while its published reconcile verdict is not clean`
    : `${who}: every migrated order is read-only`;
};

class Refused extends Error {}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
let exitCode = 0;

try {
  const [row] = await sql`SELECT value, description, updated_at FROM scm.app_config WHERE key = ${KEY}`;
  const before = row?.value ?? null;
  const beforeMsg = row?.description ?? null;

  log(`set-migrated-so-lock — MODE=${MODE}`);
  log("");
  log(`BEFORE  ${KEY} = ${JSON.stringify(before)}${row ? `   (updated ${myt(row.updated_at)} MYT)` : ""}`);
  const parsedBefore = parseMigratedSoLock(before);
  if (before === null) {
    warn("        the row is ABSENT. parseMigratedSoLock reads that as OFF — every migrated order");
    warn("        editable. Migration 20260908T0014 seeds '1', so an absent row means somebody");
    warn("        deleted it or this is not the database you think it is.");
  }
  log(`        means: ${describe(parsedBefore)}`);
  if (parsedBefore.malformed) {
    warn("        the STORED value is MALFORMED and is being read as 'all' (fail closed).");
  }
  log("");
  log(`AFTER   ${KEY} = ${JSON.stringify(TARGET)}`);
  log(`        means: ${describe(parsedAfter)}`);
  log("");

  /* WHAT CHANGES, PER COMPANY, IN DOCUMENTS — both directions, named. The
     companies come from the database, not from a constant: a rule that assumed
     1 and 2 would be wrong the day a company is added, silently. Companies
     named in either VALUE are unioned in, so a value naming a company that has
     no sales orders is still shown rather than silently ignored. */
  const companyRows = await sql`
    SELECT c.id::int AS id, c.code,
           (SELECT count(*) FROM scm.mfg_sales_orders so
             WHERE so.company_id = c.id AND so.linked_ac_docno IS NOT NULL)::int AS migrated,
           (SELECT count(*) FROM scm.mfg_sales_orders so
             WHERE so.company_id = c.id AND so.linked_ac_docno IS NULL)::int AS native
      FROM public.companies c ORDER BY c.id`;
  const known = new Map(companyRows.map((c) => [c.id, c]));
  for (const v of [parsedBefore, parsedAfter]) {
    if (Array.isArray(v.scope)) {
      for (const id of v.scope) if (!known.has(id)) known.set(id, { id, code: "(no such company)", migrated: 0, native: 0 });
    }
  }
  const companies = [...known.values()].sort((a, b) => a.id - b.id);

  const opening = [], closing = [];
  log("PER COMPANY  (migrated = documents this row can shut; new = documents it never touches)");
  for (const c of companies) {
    const from = stateFor(parsedBefore, c.id);
    const to = stateFor(parsedAfter, c.id);
    const move = RANK[to] < RANK[from] ? "OPENS" : RANK[to] > RANK[from] ? "closes" : "unchanged";
    if (move === "OPENS") opening.push(c);
    if (move === "closes") closing.push(c);
    log(`  ${String(c.id).padStart(3)} ${String(c.code ?? "").padEnd(10)}`
      + ` migrated=${String(c.migrated).padStart(6)} new=${String(c.native).padStart(6)}`
      + `   ${from} -> ${to}   ${move}`);
  }
  log("");

  /* THE ASYMMETRY, said out loud both ways. Opening is what needs permission;
     closing is what needs to be visible. Printing only the direction that is
     gated is how a lift silently takes something away — docs/bugs/0710 §2. */
  const docs = (xs) => xs.reduce((n, c) => n + c.migrated, 0);
  if (opening.length) {
    warn(`OPENS migrated orders in ${opening.length} company/companies`
      + ` (${docs(opening)} document(s)): ${opening.map((c) => `${c.id} ${c.code}`).join(", ")}`);
    warn("  These are documents the owner ruled shut on 2026-09-08. Two live risks ride on that:");
    warn("  sync-ac-delta can overwrite a staff edit, and AutoCount payments since 2026-08-28 have");
    warn("  never reached the ERP, so the balance shown on a migrated order is wrong.");
    warn("  Set ALLOW_OPEN=yes if opening them is deliberate.");
  } else {
    log("OPENS nothing — no company's migrated orders become editable by this value.");
  }
  if (closing.length) {
    warn(`STOPS ALLOWING edits in ${closing.length} company/companies`
      + ` (${docs(closing)} document(s)): ${closing.map((c) => `${c.id} ${c.code}`).join(", ")}`);
    warn("  Staff who can edit those documents today will get a 409 within ~30 seconds.");
  } else {
    log("STOPS ALLOWING nothing — no company loses an edit it has today.");
  }
  log("");
  log("NEW sales orders are not affected by this row in EITHER direction. It is a predicate over");
  log("documents the ERP believes came from AutoCount; see docs/bugs/0703 for which ones those are.");

  log("");
  log(`STAFF MESSAGE  ${MESSAGE === null
        ? `unchanged: ${JSON.stringify(beforeMsg)}`
        : `${JSON.stringify(beforeMsg)} -> ${JSON.stringify(MESSAGE)}`}`);
  if (parsedAfter.byVerdict && MESSAGE !== null) {
    warn("  verdict: mode does NOT consult app_config.description — the refusal names the document");
    warn("  and the axis instead. This sentence will be stored and never shown.");
  }
  log("");
  log(`TO REVERSE THIS, re-run with: VALUE=${JSON.stringify(before === null ? "off" : before)}`);

  if (before === TARGET) {
    log("");
    log("ALREADY SET — the stored value is already exactly this. Nothing to write.");
  } else if (MODE === "plan") {
    log("");
    log("PLAN ONLY — nothing was written. Re-run with MODE=apply and the confirm phrase.");
  } else {
    /* THROWN, not a flag set. A script that reads CONFIRM, logs about it and
       carries on is exactly the shape that writes anyway — the release-
       discipline check refuses to count that as a refusal, correctly. */
    if (CONFIRM !== CONFIRM_PHRASE) {
      throw new Refused(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}".`);
    }
    if (opening.length && !ALLOW_OPEN) {
      throw new Refused(
        `this OPENS ${docs(opening)} migrated document(s) in company/companies `
        + `${opening.map((c) => c.id).join(", ")}.\n`
        + "  Set ALLOW_OPEN=yes if that is deliberate.");
    }

    /* Names its columns on the UPDATE arm so `description` — the sentence staff
       read on a locked order — is only touched when MESSAGE says to. An upsert
       of the whole row would blank it on every change. */
    if (MESSAGE === null) {
      await sql`
        INSERT INTO scm.app_config (key, value, updated_at)
        VALUES (${KEY}, ${TARGET}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    } else {
      await sql`
        INSERT INTO scm.app_config (key, value, description, updated_at)
        VALUES (${KEY}, ${TARGET}, ${MESSAGE}, now())
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`;
    }

    /* VERIFY on a FRESH connection, and assert the SHAPE — what the middleware
       will RESOLVE, company by company — not that one row came back. A stored
       string that parses to a different answer than intended is the failure
       mode here, and a row count cannot see it. */
    const check = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
    try {
      const [after] = await check`SELECT value, description FROM scm.app_config WHERE key = ${KEY}`;
      const got = after?.value ?? null;
      const p = parseMigratedSoLock(got);
      log("");
      log(`VERIFIED on a fresh connection — stored ${JSON.stringify(got)}`);
      log(`  means: ${describe(p)}`);
      const mismatched = companies.filter((c) => stateFor(p, c.id) !== stateFor(parsedAfter, c.id));
      for (const c of companies) log(`  company ${c.id} resolves to ${stateFor(p, c.id)}`);
      const msgNow = after?.description ?? null;
      const msgWant = MESSAGE === null ? beforeMsg : MESSAGE;
      log(`  staff message is now ${JSON.stringify(msgNow)}`);
      if (msgNow !== msgWant) {
        console.error(`WRONG SHAPE — the staff message should be ${JSON.stringify(msgWant)}`);
        exitCode = 1;
      }
      if (p.malformed || mismatched.length > 0) {
        console.error("WRONG SHAPE — what is stored does not resolve to what was intended.");
        for (const c of mismatched) {
          console.error(`  company ${c.id}: intended ${stateFor(parsedAfter, c.id)}, resolves to ${stateFor(p, c.id)}`);
        }
        exitCode = 1;
      } else {
        log("  SHAPE OK — the middleware will resolve exactly this within ~30s (per-isolate cache).");
      }
    } finally { await check.end({ timeout: 5 }); }
  }
} catch (err) {
  if (err instanceof Refused) {
    console.error(`REFUSED — ${err.message}`);
    console.error("Nothing was written.");
    exitCode = 2;
  } else { throw err; }
} finally {
  await sql.end({ timeout: 5 });
}
process.exitCode = exitCode;
