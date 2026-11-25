// Pull every Delivered-To / X-Original-To header off the parsed message. These
// are the ENVELOPE recipients the receiving server saw — with the free-alias
// model (operation@/sales@/marketing@/finance@/hr@ are all aliases of hello@),
// the dept alias the sender used lands HERE, not necessarily in To:. We surface
// them so the ERP can route the message to the right department mailbox.
//
// mailparser exposes headers two ways: parsed.headers (a Map, lowercased keys,
// value collapsed to a string when single / array when repeated) and
// parsed.headerLines (the raw "key: value" lines). Gmail repeats Delivered-To,
// so we read BOTH sources and union the addresses. Returns bare addresses.
//
// X-Gm-Original-To comes first: a Google catch-all rule rewrites the envelope to
// hello@, so Delivered-To says hello@ while this header keeps the address the
// sender used (zaim@). Without it, every catch-all mail lands on hello@.
const ENVELOPE_HEADERS = ["x-gm-original-to", "delivered-to", "x-original-to"];
const ADDR_IN_ANGLE_RE = /<([^>]+)>/g;
function extractAddresses(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  const out = [];
  let m;
  ADDR_IN_ANGLE_RE.lastIndex = 0;
  while ((m = ADDR_IN_ANGLE_RE.exec(s))) {
    const a = m[1].trim();
    if (a.includes("@")) out.push(a);
  }
  if (out.length === 0 && s.includes("@")) {
    // No angle brackets — split on commas/whitespace and keep the @-tokens.
    for (const tok of s.split(/[,\s]+/)) {
      const t = tok.trim().replace(/^<|>$/g, "");
      if (t.includes("@")) out.push(t);
    }
  }
  return out;
}

export function deliveredToList(parsed) {
  const out = [];
  const push = (raw) => {
    for (const a of extractAddresses(raw)) out.push(a);
  };
  const headers = parsed.headers;
  if (headers && typeof headers.get === "function") {
    for (const key of ENVELOPE_HEADERS) {
      const v = headers.get(key);
      if (Array.isArray(v)) v.forEach(push);
      else if (v) push(v);
    }
  }
  // Belt-and-braces: also scan the raw header lines (catches repeated headers
  // that the Map collapsed, and X-Original-To variants).
  const lines = Array.isArray(parsed.headerLines) ? parsed.headerLines : [];
  for (const ln of lines) {
    const key = String((ln && ln.key) || "").toLowerCase();
    if (ENVELOPE_HEADERS.includes(key)) {
      const line = String((ln && ln.line) || "");
      const colon = line.indexOf(":");
      push(colon >= 0 ? line.slice(colon + 1) : line);
    }
  }
  // De-dup, order-preserving (lowercased compare).
  const seen = new Set();
  const dedup = [];
  for (const a of out) {
    const lc = a.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    dedup.push(a);
  }
  return dedup;
}
