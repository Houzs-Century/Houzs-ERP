// ─────────────────────────────────────────────────────────────────────────
// assrMyCases.ts — the row rule for /api/assr/my-cases, in one testable home.
//
// My Cases answers "which service cases belong to this sales rep" by matching
// assr_cases.sales_agent — free text mirrored from AutoCount — against the
// display names of the caller's reporting subtree (self + manager_id downline,
// services/orgScope.ts). Names are how LEGACY cases are reached; nothing else
// on those rows links to a user account.
//
// Two ways that text match lost real cases (Shawn, 2026-08-21):
//
//   1. A case the rep RAISED THEMSELVES carries the SO's agent name, not
//      theirs. A rep covering a resigned agent's customers creates a case,
//      lands on its detail once, and it never appears in their list again —
//      which reads as "create failed". created_by is stamped on every create
//      and is authoritative, so it is now an OR-arm of the rule.
//
//   2. AutoCount spells people differently than users.name does: PEIFEN vs
//      "Pei Fen", SHELDON vs "Sheldon Tan", LUIS vs "Luis Teo". The old rule
//      was one-directional substring over raw text (agent LIKE %name%), so a
//      space or a dropped surname silently orphaned the whole set. Both sides
//      are now compared space-stripped and lowercased, in BOTH directions —
//      agent-contains-name (the original arm, widened only by the space
//      stripping) OR name-contains-agent (new; catches the agent-is-a-prefix
//      spellings). The reverse arm requires the stripped agent to be at least
//      MIN_REVERSE_AGENT_LEN characters, so initials like "CH" or "DS" cannot
//      claim half the org chart.
//
// Space-stripping both sides is strictly widening for the forward arm:
// substring containment survives deleting the same character everywhere on
// both sides (strip(x + name + y) = strip(x) + strip(name) + strip(y)), so
// every pair the old rule matched still matches.
//
// The builder returns SQL with `?` placeholders and the bind list, ready to
// splice into the route's WHERE. SQLite (D1 test mirror / shim) and Postgres
// agree on every function used: REPLACE, LOWER, TRIM, LENGTH, ||.
// ─────────────────────────────────────────────────────────────────────────

/** Reverse-arm guard: a stripped agent shorter than this never matches by
 *  containment-in-name. "CH" / "DS" are initials, not identities. */
export const MIN_REVERSE_AGENT_LEN = 4;

/** users.name / sales_agent, normalised the way both sides are compared:
 *  lowercased with ALL whitespace removed. */
export function normalizeAgentName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "");
}

const STRIPPED_AGENT_SQL = `REPLACE(LOWER(COALESCE(sales_agent, '')), ' ', '')`;

/**
 * The OR-group for the My Cases WHERE clause: one bidirectional name arm per
 * subtree name, plus `created_by = caller`. Always non-empty — even a caller
 * whose subtree resolved to no names (a user row with a blank name) still
 * sees the cases they raised.
 */
export function myCasesPredicate(
  names: string[],
  userId: number,
): { sql: string; binds: (string | number)[] } {
  const arms: string[] = [];
  const binds: (string | number)[] = [];
  for (const raw of names) {
    const n = normalizeAgentName(raw);
    if (!n) continue;
    arms.push(
      `(${STRIPPED_AGENT_SQL} LIKE ? OR ` +
        `(LENGTH(${STRIPPED_AGENT_SQL}) >= ${MIN_REVERSE_AGENT_LEN} ` +
        `AND ? LIKE '%' || ${STRIPPED_AGENT_SQL} || '%'))`,
    );
    binds.push(`%${n}%`, n);
  }
  arms.push(`created_by = ?`);
  binds.push(userId);
  return { sql: `(${arms.join(" OR ")})`, binds };
}
