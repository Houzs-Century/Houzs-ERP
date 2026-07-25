// Set (or overwrite) POS PINs for named staff — the write-side sibling of
// check-soak-gate.mjs, and the same reasoning: the owner asked for a PIN
// change, the hash lives only in production's scm.pos_pins, and the only
// credential that can reach it sits in Actions as secrets.DATABASE_URL. So
// the change runs THERE, and no human handles the DSN.
//
// This is deliberately NOT the read-only check pattern (it writes), so it
// keeps the same guardrails a write needs:
//
//   - Input is PRE-HASHED. The workflow input carries PBKDF2 hashes in the
//     exact format services/auth.ts produces (b64(salt)$b64(hash), SHA-256,
//     100k iterations) — the plaintext PIN never appears in run logs or the
//     dispatch payload. Hash locally with:
//       node -e "const c=require('crypto');const s=c.randomBytes(16);
//                const b=c.pbkdf2Sync(process.argv[1],s,100000,32,'sha256');
//                console.log(s.toString('base64')+'$'+b.toString('base64'))" 123456
//   - It refuses ambiguity. A name that matches zero or several scm.staff
//     rows writes NOTHING for that entry — it lists the candidates and moves
//     on. Re-run with the staff uuid as the match to disambiguate.
//   - Only rows with a linked Houzs user are eligible: /pos/pin-login
//     requires s.user_id IS NOT NULL, so a PIN on an unlinked (2990 mirror)
//     row is a credential that can never log in. Linked-row matches win;
//     unlinked ones are listed for reference only.
//   - DRY_RUN=1 resolves and reports but does not write.
//
// Exit 0 for every legitimate answer (including "ambiguous, wrote nothing");
// non-zero only for an unreachable DB or malformed input.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/;

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

let assignments;
try {
  assignments = JSON.parse(process.env.ASSIGNMENTS ?? "[]");
  if (!Array.isArray(assignments) || assignments.length === 0) throw new Error("empty");
  for (const a of assignments) {
    if (typeof a?.match !== "string" || !a.match.trim()) throw new Error("bad match");
    if (typeof a?.pin_hash !== "string" || !HASH_RE.test(a.pin_hash)) throw new Error("bad pin_hash");
  }
} catch (e) {
  console.error(`ASSIGNMENTS must be a non-empty JSON array of {match, pin_hash}: ${e.message}`);
  process.exit(1);
}

const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  for (const { match, pin_hash } of assignments) {
    const m = match.trim();
    const rows = UUID_RE.test(m)
      ? await pg`
          SELECT s.id, s.staff_code, s.name, s.user_id,
                 (p.staff_id IS NOT NULL) AS has_pin
          FROM scm.staff s
          LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
          WHERE s.id = ${m}`
      : await pg`
          SELECT s.id, s.staff_code, s.name, s.user_id,
                 (p.staff_id IS NOT NULL) AS has_pin
          FROM scm.staff s
          LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
          WHERE s.name ILIKE ${"%" + m + "%"} OR s.staff_code ILIKE ${"%" + m + "%"}
          ORDER BY s.name`;

    const linked = rows.filter((r) => r.user_id != null);

    if (rows.length === 0) {
      notice(`'${m}': NO staff row matches. Wrote nothing.`);
      continue;
    }
    if (linked.length !== 1) {
      notice(
        `'${m}': ${rows.length} match(es), ${linked.length} with a linked Houzs user — ambiguous, wrote nothing. ` +
          `Candidates: ` +
          rows
            .map((r) => `${r.name} [${r.staff_code}] id=${r.id} user_id=${r.user_id ?? "NONE"} has_pin=${r.has_pin}`)
            .join(" | ") +
          `. Re-run with the staff uuid as 'match'.`,
      );
      continue;
    }

    const t = linked[0];
    if (dryRun) {
      notice(`'${m}': DRY RUN — would set PIN for ${t.name} [${t.staff_code}] id=${t.id} (has_pin=${t.has_pin}).`);
      continue;
    }
    await pg`
      INSERT INTO scm.pos_pins (staff_id, pin_hash, updated_at)
      VALUES (${t.id}, ${pin_hash}, now())
      ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now()`;
    notice(`'${m}': PIN ${t.has_pin ? "REPLACED" : "SET"} for ${t.name} [${t.staff_code}] id=${t.id}.`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
