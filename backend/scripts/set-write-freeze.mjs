#!/usr/bin/env node
/* set-write-freeze — open (or re-close) SCM modules for staff, by writing
 * `scm.app_config['scm.write_freeze']`. Takes effect within ~30s, no deploy:
 * the middleware caches the row for that long, per isolate.
 *
 * WHY IT EXISTS. Lifting the freeze was a SQL statement in a runbook, and the
 * owner is not a database console (CLAUDE.md). It is also the single most
 * consequential value in `app_config` — it decides whether the floor can save
 * anything at all — so it deserves a plan step, a confirm phrase and a printed
 * before/after far more than a paste into a console does.
 *
 * THE VALUE IS THE WHOLE LIST OF WHAT IS OPEN. NOT an addition.
 * `"1 - scm.sales.delivery"` opens delivery orders AND RE-CLOSES everything
 * else that was open, including `scm.procurement.products`, which has been open
 * to staff since 2026-09-02. This script therefore prints what it is CLOSING as
 * loudly as what it is opening, and refuses an apply that closes an area unless
 * `ALLOW_CLOSE=yes` says so out loud. That asymmetry is deliberate: opening the
 * wrong module is visible within minutes, silently re-freezing one somebody
 * relies on looks like the ERP being broken and nobody connects it to this.
 *
 * EVERY AREA IS VALIDATED against the mounts in `scm/lib/scm-areas.ts`, through
 * the SAME reader the read-only checker uses (`lib/scm-area-keys.mjs`) — never a
 * second copy of the parse. An unknown token is refused rather than written: the
 * middleware treats a token it cannot resolve as "stays frozen", so a typo would
 * otherwise be a silent no-op that reads as a successful lift.
 *
 *   DATABASE_URL   required
 *   MODE           plan (default) | apply
 *   AREAS          comma-separated area keys to be OPEN, or `off` to open
 *                  everything, or `none` to freeze the whole surface
 *   COMPANY        the company id the value is scoped to (default 1)
 *   CONFIRM        on apply, must equal "SET WRITE FREEZE"
 *   ALLOW_CLOSE    "yes" to permit an apply that closes a currently-open area
 *   MESSAGE        optional. The sentence staff see when a module is frozen —
 *                  it lives in `app_config.description`, not in the value.
 *                  OMITTED LEAVES THE EXISTING ONE ALONE, which is why the
 *                  write names its columns instead of upserting a whole row: a
 *                  lift that silently blanked the explanation would leave staff
 *                  facing a refusal with nothing to read.
 *
 * RE-RUN: idempotent. A second run with the same AREAS reads the row, finds the
 * value already equal, writes nothing and says so. It is a SET, not a toggle.
 *
 * REVERSAL: re-run with the PREVIOUS value, which every run prints in full and
 * in the exact syntax this script accepts. Nothing else has to be undone — no
 * document changes and no schema changes.
 */
import postgres from "postgres";
import { readScmAreaKeys, validateFreezeValue, describeFreezeValue } from "./lib/scm-area-keys.mjs";

const KEY = "scm.write_freeze";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const MODE = (process.env.MODE || "plan").trim().toLowerCase();
if (MODE !== "plan" && MODE !== "apply") {
  console.error(`MODE must be plan or apply, got ${JSON.stringify(MODE)}`); process.exit(1);
}
const COMPANY = (process.env.COMPANY || "1").trim();
if (!/^[0-9]+$/.test(COMPANY)) { console.error(`COMPANY must be a number, got ${COMPANY}`); process.exit(1); }
const RAW_AREAS = (process.env.AREAS ?? "").trim();
if (RAW_AREAS === "") { console.error("AREAS not set. Pass area keys, or 'off', or 'none'."); process.exit(1); }
const ALLOW_CLOSE = (process.env.ALLOW_CLOSE || "").trim().toLowerCase() === "yes";
const CONFIRM = process.env.CONFIRM ?? "";
const CONFIRM_PHRASE = "SET WRITE FREEZE";
const RAW_MESSAGE = process.env.MESSAGE ?? "";
const MESSAGE = RAW_MESSAGE.trim() === "" ? null : RAW_MESSAGE.trim();

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);

/* readScmAreaKeys returns a SET, and the read-only checker spreads it before
   using it. Normalised here once, sorted, so every comparison below is an array
   and no call site has to remember which it got. */
const areaKeys = [...readScmAreaKeys()].sort();
if (areaKeys.length === 0) {
  console.error("Could not read the SCM area keys. Refusing to write a value nothing validated.");
  process.exit(1);
}

/* The value the middleware will read. `off` opens everything; `none` freezes the
   whole surface for this company; otherwise it is `<company> - <areas>`. */
let target;
const lower = RAW_AREAS.toLowerCase();
if (lower === "off") {
  target = "off";
} else if (lower === "none") {
  target = COMPANY;
} else {
  const wanted = RAW_AREAS.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((a) => !areaKeys.includes(a));
  if (unknown.length) {
    console.error(`REFUSED — these are not SCM areas: ${unknown.join(", ")}`);
    console.error("The middleware treats a token it cannot resolve as STAYS FROZEN, so writing this");
    console.error("would look like a successful lift and open nothing. Known areas:");
    for (const a of areaKeys) console.error(`  ${a}`);
    process.exit(1);
  }
  target = `${COMPANY} - ${[...new Set(wanted)].join(", ")}`;
}

/* A refusal is not a crash: it prints one sentence and exits 2, with no stack,
   because the reader is an operator and the stack tells them nothing. */
class Refused extends Error {}

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
let exitCode = 0;

try {
  const [row] = await sql`SELECT value, description, updated_at FROM scm.app_config WHERE key = ${KEY}`;
  const before = row?.value ?? null;
  const beforeMsg = row?.description ?? null;

  log(`set-write-freeze — MODE=${MODE}`);
  log("");
  log(`BEFORE  ${KEY} = ${JSON.stringify(before)}`);
  const parsedBefore = before === null ? null : validateFreezeValue(before, areaKeys);
  if (parsedBefore) log(`        means: ${describeFreezeValue(parsedBefore)}`);
  else warn("        the row is ABSENT — migration 0272 seeds 'off', so an absent row reads as OPEN.");
  log("");
  log(`AFTER   ${KEY} = ${JSON.stringify(target)}`);
  const parsedAfter = validateFreezeValue(target, areaKeys);
  log(`        means: ${describeFreezeValue(parsedAfter)}`);
  if (!parsedAfter.ok) {
    console.error("REFUSED — the value this script built does not parse. Nothing was written.");
    for (const p of parsedAfter.problems) console.error(`  ${p}`);
    exitCode = 1;
  }

  /* WHAT CHANGES, both directions, named. A lift that silently re-closes
     something is the failure this section exists to make impossible to miss. */
  const openBefore = parsedBefore?.ok ? (parsedBefore.scope === "off" ? [...areaKeys] : parsedBefore.open) : [];
  const openAfter = parsedAfter.ok ? (parsedAfter.scope === "off" ? [...areaKeys] : parsedAfter.open) : [];
  const opening = openAfter.filter((a) => !openBefore.includes(a)).sort();
  const closing = openBefore.filter((a) => !openAfter.includes(a)).sort();

  log("");
  log(`OPENING (${opening.length}): ${opening.length ? opening.join(", ") : "nothing new"}`);
  if (closing.length) {
    warn(`CLOSING (${closing.length}): ${closing.join(", ")}`);
    warn("  These are open TODAY and this value takes them away. The value is the whole");
    warn("  list of what is open, not an addition. If that is not what you meant, put them");
    warn("  back into AREAS. To do it on purpose, set ALLOW_CLOSE=yes.");
  } else {
    log("CLOSING (0): nothing that is open today is taken away");
  }
  log(`STILL FROZEN (${areaKeys.length - openAfter.length}): ${areaKeys.filter((a) => !openAfter.includes(a)).sort().join(", ") || "none"}`);

  log("");
  log(`STAFF MESSAGE  ${MESSAGE === null
        ? `unchanged: ${JSON.stringify(beforeMsg)}`
        : `${JSON.stringify(beforeMsg)} -> ${JSON.stringify(MESSAGE)}`}`);

  log("");
  log(`TO REVERSE THIS, re-run with: AREAS=${before === null ? "off" : (parsedBefore?.ok && parsedBefore.scope !== "off" ? parsedBefore.open.join(",") : before)}`);

  if (exitCode === 0 && before === target) {
    log("");
    log("ALREADY SET — the stored value is already exactly this. Nothing to write.");
  } else if (exitCode === 0 && MODE === "plan") {
    log("");
    log("PLAN ONLY — nothing was written. Re-run with MODE=apply and the confirm phrase.");
  } else if (exitCode === 0) {
    /* THROWN, not a flag set. An earlier draft wrote `exitCode = 1` and carried
       on, and the release-discipline check refused to count that as a refusal —
       correctly: a script that reads CONFIRM, logs about it and keeps going is
       exactly the shape that writes anyway. The throw unwinds to the finally,
       which still closes the pool, and nothing below it can run. */
    if (CONFIRM !== CONFIRM_PHRASE) {
      throw new Refused(`MODE=apply needs CONFIRM="${CONFIRM_PHRASE}".`);
    }
    if (closing.length && !ALLOW_CLOSE) {
      throw new Refused(
        `this would CLOSE ${closing.length} area(s) that are open today: ${closing.join(", ")}
` +
        "  Set ALLOW_CLOSE=yes if that is deliberate, or add them back to AREAS.");
    }
    {
      /* Names its columns on the UPDATE arm so `description` — the sentence
         staff read when a module refuses them — is only touched when MESSAGE
         says to. An upsert of the whole row would blank it on every lift. */
      if (MESSAGE === null) {
        await sql`
          INSERT INTO scm.app_config (key, value, updated_at)
          VALUES (${KEY}, ${target}, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      } else {
        await sql`
          INSERT INTO scm.app_config (key, value, description, updated_at)
          VALUES (${KEY}, ${target}, ${MESSAGE}, now())
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`;
      }

      /* VERIFY on a FRESH connection, and assert the SHAPE — what the middleware
         will RESOLVE — not that one row came back. A stored string that parses to
         a different set of open areas than intended is the failure mode here, and
         a row count cannot see it. */
      const check = postgres(DSN, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
      try {
        const [after] = await check`SELECT value, description FROM scm.app_config WHERE key = ${KEY}`;
        const got = after?.value ?? null;
        const p = got === null ? null : validateFreezeValue(got, areaKeys);
        const resolved = p?.ok ? (p.scope === "off" ? [...areaKeys] : [...p.open].sort()) : null;
        const want = [...openAfter].sort();
        const same = resolved !== null && resolved.length === want.length && resolved.every((a, i) => a === want[i]);
        log("");
        log(`VERIFIED on a fresh connection — stored ${JSON.stringify(got)}`);
        log(`  resolves to ${resolved ? resolved.length : "UNPARSEABLE"} open area(s): ${resolved ? resolved.join(", ") || "none" : "-"}`);
        const msgNow = after?.description ?? null;
        const msgWant = MESSAGE === null ? beforeMsg : MESSAGE;
        log(`  staff message is now ${JSON.stringify(msgNow)}`);
        if (msgNow !== msgWant) {
          console.error(`WRONG SHAPE — the staff message should be ${JSON.stringify(msgWant)}`);
          exitCode = 1;
        }
        if (!same) {
          console.error("WRONG SHAPE — what is stored does not resolve to what was intended.");
          console.error(`  intended: ${want.join(", ") || "none"}`);
          exitCode = 1;
        } else {
          log("  SHAPE OK — the middleware will open exactly the intended areas within ~30s.");
        }
      } finally { await check.end({ timeout: 5 }); }
    }
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
