// Pure half of check-top-client-errors.mjs: classify, scrub and group the rows
// of client_errors so the report is testable without a database.
//
// THE OUTPUT GOES TO A PUBLIC ACTIONS LOG. Everything printed passes through
// scrubText()/normalizeRoute() first. A JS error message is usually code
// vocabulary ("Cannot read properties of undefined (reading 'name')"), but an
// app-thrown Error can carry a server message with a customer name, a phone
// number or an email in it. So: emails, URLs' origins and query strings, long
// digit runs, uuids, non-identifier quoted text and non-ASCII text are all
// replaced by placeholders. User ids are only ever COUNTED, never printed. The
// full text of one group is recoverable privately from its dedup_hash.
//
// NO SHEBANG: imported by a test (CLAUDE.md).

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[^\s@'"`<>()]+@[^\s@'"`<>()]+\.[^\s@'"`<>()]+/g;
const MAX_PRINTED = 200;

/**
 * Which pipeline produced the row. frontend/src/lib/errorReporter.ts prefixes
 * request telemetry with a bracketed label; everything else is a thrown error.
 * @param {string} message
 * @returns {"slow"|"timeout"|"api-5xx"|"rbac-403"|"js"}
 */
export function classifyKind(message) {
  const m = /^\[(slow [^\]]+|timeout|api \d{3}|rbac 403)\]/.exec(message ?? "");
  if (!m) return "js";
  if (m[1].startsWith("slow")) return "slow";
  if (m[1] === "timeout") return "timeout";
  if (m[1] === "rbac 403") return "rbac-403";
  return "api-5xx";
}

/** Quoted text that is code vocabulary (a property, a module path) is kept;
 *  anything with spaces or other characters may be a person's data. */
function scrubQuoted(_whole, open, body, close) {
  const safe = body.length <= 60 && /^[A-Za-z0-9_$.\-/:#@]*$/.test(body) && !/\d{3,}/.test(body);
  return `${open}${safe ? body : "<str>"}${close}`;
}

/**
 * Make one message or stack line safe for a public log.
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function scrubText(text) {
  let s = String(text ?? "");
  s = s.replace(EMAIL_RE, "<email>");
  // Keep a URL's path (a chunk name is the useful part), drop host and query.
  s = s.replace(/https?:\/\/[^/\s'"`)]+/g, "");
  s = s.replace(/\?[^\s'"`)]*/g, "");
  s = s.replace(UUID_RE, "<uuid>");
  s = s.replace(/(['"`‘“])([^'"`’”\n]*)(['"`’”])/g, scrubQuoted);
  s = s.replace(/\d{3,}/g, "<n>");
  s = s.replace(/[^\x00-\x7F]+/g, "<text>");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > MAX_PRINTED ? `${s.slice(0, MAX_PRINTED)}...` : s;
}

/**
 * A page pathname with every id-like segment collapsed, so /orders/123 and
 * /orders/456 are one page and no document number reaches the log.
 * @param {string|null|undefined} route
 */
export function normalizeRoute(route) {
  const path = String(route ?? "").split("?")[0].split("#")[0];
  if (!path) return "(none)";
  return path
    .split("/")
    .map((seg) => (/\d/.test(seg) || /[^\x00-\x7F]/.test(seg) || seg.length > 40 ? ":id" : seg))
    .join("/");
}

/**
 * The first stack frame that is not the message line, scrubbed. For a minified
 * bundle this is the chunk + function name, which is what points at the code.
 * @param {string|null|undefined} stack
 */
export function topFrame(stack) {
  if (!stack) return "";
  const line = String(stack)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /^at\s|@/.test(l) && !/^\w*Error:/.test(l));
  return line ? scrubText(line) : "";
}

/**
 * Merge the per-hash rows into signatures (kind + scrubbed message + page) and
 * return the top `limit` by occurrences, plus the window's totals.
 *
 * @param {Array<{dedup_hash: string, message: string, route: string, build_id: string,
 *   n: number|string, first_seen: string, last_seen: string, users: Array<number|string>,
 *   stack: string|null}>} rows
 * @param {number} limit
 */
export function groupTopErrors(rows, limit) {
  const groups = new Map();
  const allUsers = new Set();
  const byKind = {};
  let occurrences = 0;
  for (const r of rows) {
    const kind = classifyKind(r.message);
    const message = scrubText(r.message);
    const page = normalizeRoute(r.route);
    const key = `${kind}\u0000${message}\u0000${page}`;
    const n = Number(r.n) || 0;
    occurrences += n;
    byKind[kind] = (byKind[kind] ?? 0) + n;
    const users = (r.users ?? []).map(Number);
    for (const u of users) allUsers.add(u);
    let g = groups.get(key);
    if (!g) {
      g = {
        kind,
        message,
        page,
        count: 0,
        users: new Set(),
        builds: new Set(),
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        latestBuild: r.build_id,
        frame: "",
        sampleHash: r.dedup_hash,
        hashes: 0,
      };
      groups.set(key, g);
    }
    g.count += n;
    g.hashes += 1;
    for (const u of users) g.users.add(u);
    g.builds.add(r.build_id ?? "");
    if (r.first_seen && (!g.firstSeen || r.first_seen < g.firstSeen)) g.firstSeen = r.first_seen;
    if (r.last_seen && (!g.lastSeen || r.last_seen >= g.lastSeen)) {
      g.lastSeen = r.last_seen;
      g.latestBuild = r.build_id;
    }
    if (!g.frame && r.stack) g.frame = topFrame(r.stack);
  }
  const top = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.users.size - a.users.size)
    .slice(0, limit)
    .map((g) => ({
      kind: g.kind,
      message: g.message,
      page: g.page,
      count: g.count,
      distinctUsers: g.users.size,
      distinctBuilds: g.builds.size,
      latestBuild: String(g.latestBuild ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24),
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      frame: g.frame,
      sampleHash: String(g.sampleHash ?? "").slice(0, 16),
      hashes: g.hashes,
    }));
  return {
    top,
    totals: { signatures: groups.size, occurrences, distinctUsers: allUsers.size, byKind },
  };
}
