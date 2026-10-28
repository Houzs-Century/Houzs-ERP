// Drift comparison for the route-capability matrix, kept pure and
// dependency-free so it can be tested without parsing the backend
// (see ../../tests/routeMatrixDrift.node.mjs).
//
// WHY THIS EXISTS AT ALL
//
// `npm run audit:routes` compares the committed
// docs/generated/route-capability-matrix.csv against a fresh generation, and it
// used to do that BYTE FOR BYTE. The matrix recorded `file:line` for every
// route, so the artifact went stale whenever any other change shifted a line —
// a comment block added to a route file was enough. A stale matrix fails the
// whole backend CI job and, because deploy.yml and deploy-staging.yml run the
// same command, it also jams prod and staging deploys.
//
// #953 stripped the trailing `:<line>` inside the comparison, which fixed the
// comment-block case but left two mechanisms intact:
//
//   1. the volatile line numbers were still IN the committed artifact, so the
//      file still had to be regenerated for cosmetic reasons, still produced
//      merge conflicts against every other open PR, and still carried numbers
//      that were wrong the moment anything above them moved;
//   2. the comparison was still ORDER-SENSITIVE. This artifact is a sorted,
//      generated file that git nonetheless text-merges. Two PRs that each add a
//      route can merge cleanly into an interleaving that is not the order a
//      fresh generation produces — nobody's CI ever saw that tree, and main
//      lands stale, which is the deploy-jamming case.
//
// So the compared artifact is now SEMANTIC ONLY (no line numbers at all — they
// are available on demand via `--locations`) and the comparison is a MULTISET
// comparison: same rows, same counts, order irrelevant.
//
// WHAT IS DELIBERATELY NOT RELAXED
//
// Every column that carries authorization meaning is compared exactly:
// auth_boundary, company_boundary, mount_gate, router_gate, direct_gate,
// handler_guard, mutation and review_state — plus method and path themselves.
// A route appearing, disappearing, moving to a different FILE, or having ANY
// gate added, removed or reworded is a difference, is reported by name, and
// fails. The only thing that stopped being drift is a route sitting on a
// different line of the same file, which is not a fact about authorization.

/** Columns whose change is an authorization change. Reported first, and loudly. */
export const SECURITY_COLUMNS = [
  "auth_boundary",
  "company_boundary",
  "mount_gate",
  "router_gate",
  "direct_gate",
  "handler_guard",
  "review_state",
];

/** Minimal RFC4180 parser: handles quoted fields containing , " and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  // Normalise line endings first: git's autocrlf checks this artifact out as
  // CRLF on Windows and LF in Actions, and that is not drift.
  const src = text.replace(/\r\n/g, "\n");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV text -> { headers, records }. A record is a plain object, header-keyed. */
export function readMatrix(text) {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) return { headers: [], records: [] };
  const [headers, ...body] = rows;
  const records = body.map((cells) =>
    Object.fromEntries(headers.map((h, idx) => [h, cells[idx] ?? ""]))
  );
  return { headers, records };
}

/** Stable, order-independent identity for one row: every column, in header order. */
function recordKey(headers, record) {
  return headers.map((h) => record[h] ?? "").join("\u0000");
}

/** How a row is named in a report. */
function label(record) {
  return `${record.method} ${record.path}  (${record.source})`;
}

function countBy(headers, records) {
  const counts = new Map();
  for (const record of records) {
    const key = recordKey(headers, record);
    const entry = counts.get(key) ?? { record, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return counts;
}

/**
 * Compare a committed matrix against a freshly generated one.
 *
 * Returns { drifted, added, removed, changed, securityChanges, headersChanged }.
 *   changed          — rows paired on (method, path, source) whose other
 *                      columns moved; this is where a gate change shows up
 *   added / removed  — rows with no counterpart at all
 *   securityChanges  — the subset of `changed` touching SECURITY_COLUMNS, plus
 *                      every add/remove (a route appearing or disappearing is
 *                      an authorization-surface change by definition)
 */
export function diffMatrices(committedText, generatedText) {
  const committed = readMatrix(committedText);
  const generated = readMatrix(generatedText);

  const headersChanged =
    JSON.stringify(committed.headers) !== JSON.stringify(generated.headers);
  // With different columns there is nothing meaningful to pair on; report it as
  // one unambiguous fact rather than as several hundred phantom row changes.
  if (headersChanged) {
    return {
      drifted: true,
      headersChanged,
      committedHeaders: committed.headers,
      generatedHeaders: generated.headers,
      added: [],
      removed: [],
      changed: [],
      securityChanges: [],
    };
  }

  const headers = generated.headers;
  const before = countBy(headers, committed.records);
  const after = countBy(headers, generated.records);

  const surplus = []; // in generated, not (or not often enough) in committed
  const missing = []; // in committed, not in generated
  for (const [key, entry] of after) {
    const delta = entry.count - (before.get(key)?.count ?? 0);
    for (let n = 0; n < delta; n += 1) surplus.push(entry.record);
  }
  for (const [key, entry] of before) {
    const delta = entry.count - (after.get(key)?.count ?? 0);
    for (let n = 0; n < delta; n += 1) missing.push(entry.record);
  }

  // Pair surplus against missing on the route's identity so a gate change reads
  // as "this route's gate moved", not as an unrelated add plus an unrelated
  // remove. Identity is method + path + source FILE — everything else is the
  // payload being compared.
  const identity = (r) => `${r.method}\u0000${r.path}\u0000${r.source}`;
  const missingByIdentity = new Map();
  for (const record of missing) {
    const list = missingByIdentity.get(identity(record)) ?? [];
    list.push(record);
    missingByIdentity.set(identity(record), list);
  }

  const added = [];
  const changed = [];
  for (const record of surplus) {
    const candidates = missingByIdentity.get(identity(record));
    if (candidates && candidates.length > 0) {
      const was = candidates.shift();
      const columns = headers
        .filter((h) => (was[h] ?? "") !== (record[h] ?? ""))
        .map((h) => ({ column: h, from: was[h] ?? "", to: record[h] ?? "" }));
      changed.push({ route: label(record), was, now: record, columns });
    } else {
      added.push(record);
    }
  }
  const removed = [...missingByIdentity.values()].flat();

  const securityChanges = [
    ...added.map((r) => ({ kind: "ADDED", route: label(r), record: r })),
    ...removed.map((r) => ({ kind: "REMOVED", route: label(r), record: r })),
    ...changed
      .filter((c) => c.columns.some((col) => SECURITY_COLUMNS.includes(col.column)))
      .map((c) => ({
        kind: "GATE_CHANGED",
        route: c.route,
        columns: c.columns.filter((col) => SECURITY_COLUMNS.includes(col.column)),
      })),
  ];

  return {
    drifted: added.length > 0 || removed.length > 0 || changed.length > 0,
    headersChanged: false,
    added,
    removed,
    changed,
    securityChanges,
  };
}

/**
 * Human report for a drift. The point is that a reader can tell in one glance
 * whether a GATE moved (act now) or a route was added (regenerate) — the old
 * message was the single line "Route capability matrix is stale", which said
 * nothing and taught everyone to regenerate without looking.
 */
export function formatDiff(diff) {
  if (diff.headersChanged) {
    return [
      "Route capability matrix COLUMNS changed.",
      `  committed: ${diff.committedHeaders.join(",")}`,
      `  generated: ${diff.generatedHeaders.join(",")}`,
    ].join("\n");
  }
  const lines = [];
  const gateChanges = diff.securityChanges.filter((c) => c.kind === "GATE_CHANGED");
  if (gateChanges.length > 0) {
    lines.push("AUTHORIZATION GATES CHANGED — review these before regenerating:");
    for (const change of gateChanges) {
      lines.push(`  ${change.route}`);
      for (const col of change.columns) {
        lines.push(`    ${col.column}: "${col.from}" -> "${col.to}"`);
      }
    }
    lines.push("");
  }
  if (diff.added.length > 0) {
    lines.push(`Routes ADDED (${diff.added.length}):`);
    for (const record of diff.added) {
      lines.push(`  + ${label(record)}  auth=${record.auth_boundary} state=${record.review_state}`);
    }
    lines.push("");
  }
  if (diff.removed.length > 0) {
    lines.push(`Routes REMOVED (${diff.removed.length}):`);
    for (const record of diff.removed) {
      lines.push(`  - ${label(record)}  auth=${record.auth_boundary} state=${record.review_state}`);
    }
    lines.push("");
  }
  const other = diff.changed.filter(
    (c) => !c.columns.some((col) => SECURITY_COLUMNS.includes(col.column))
  );
  if (other.length > 0) {
    lines.push(`Rows changed, no gate involved (${other.length}):`);
    for (const change of other) {
      const cols = change.columns.map((col) => `${col.column} "${col.from}" -> "${col.to}"`).join("; ");
      lines.push(`  ~ ${change.route}: ${cols}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
