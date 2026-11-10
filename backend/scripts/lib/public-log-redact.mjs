// Pure redaction rules for public-log-guard.mjs (which installs them on the
// process streams). Kept apart so a checker can import the rules without
// patching its own output.

const HIDDEN = "[hidden]";

const MONEY_PARTS = new Set(["sen", "rm", "myr", "cost", "costs", "price", "prices", "amount", "amounts", "cogs", "revenue", "balance", "subtotal"]);
const COUNT_PARTS = new Set(["count", "counts", "qty", "rows", "lines", "lots", "items", "skus", "docs", "n", "num", "ids", "id", "code", "codes", "key", "keys", "missing", "zero"]);

// Word parts of an identifier: unit_cost_sen, unitCostSen and UNIT_COST_SEN
// all read as [unit, cost, sen].
function parts(key) {
  return String(key).split(/_+|(?<=[a-z0-9])(?=[A-Z])/).map((p) => p.toLowerCase()).filter(Boolean);
}

export function isMoneyKey(key) {
  const p = parts(key);
  return p.some((x) => MONEY_PARTS.has(x)) && !p.some((x) => COUNT_PARTS.has(x));
}

const NUM = String.raw`-?\d(?:[\d,]*\d)?(?:\.\d+)?`;
const RULES = [
  [new RegExp(String.raw`\b(RM|MYR)(\s?)${NUM}`, "g"), (_m, cur, sp) => `${cur}${sp}${HIDDEN}`],
  [new RegExp(String.raw`(^|[^\w.])${NUM}(\s?)(sen|RM|MYR)\b`, "g"), (_m, pre, sp, unit) => `${pre}${HIDDEN}${sp}${unit}`],
  [
    new RegExp(String.raw`\b([A-Za-z_][A-Za-z0-9_]*)("?\s*[=:]\s*"?|[ \t]+)${NUM}`, "g"),
    (m, key, sep) => (isMoneyKey(key) ? `${key}${sep}${HIDDEN}` : m),
  ],
  [/(^|[^\w.:-])-?\d(?:[\d,]*\d)?\.\d{2}(?![\d%.\w])/g, (_m, pre) => `${pre}${HIDDEN}`],
];

export function redactMoney(text) {
  let out = String(text);
  for (const [re, fn] of RULES) out = out.replace(re, fn);
  return out;
}

export function redactRow(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactRow(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isMoneyKey(k) && v != null && typeof v !== "object" ? HIDDEN : redactRow(v, depth + 1);
  }
  return out;
}

// A guard whose patterns match nothing reports every log as clean. Refuse to
// run rather than run unguarded.
const PROBES = [
  ["RM12.34", "RM[hidden]"],
  ["@ RM1,250.00/u", "@ RM[hidden]/u"],
  ["seed lot 7 (3 @ 12345 sen)", "seed lot 7 (3 @ [hidden] sen)"],
  ["unit_cost_sen=4500 consumed=3", "unit_cost_sen=[hidden] consumed=3"],
  ['{"total_cost_sen":900,"qty":2}', '{"total_cost_sen":[hidden],"qty":2}'],
  ["total=12.50", "total=[hidden]"],
  ["qty 3  price 4500  total 9000", "qty 3  price [hidden]  total 9000"],
  ["cost 12.5 RM", "cost [hidden] RM"],
  ["discount_sen 300 cost_count 4", "discount_sen [hidden] cost_count 4"],
  ["lots=12 qty=3 costless_count=4 2026-11-10T12:00:00.000Z 12.5%", "lots=12 qty=3 costless_count=4 2026-11-10T12:00:00.000Z 12.5%"],
];
export function selfTest() {
  for (const [input, want] of PROBES) {
    const got = redactMoney(input);
    if (got !== want) throw new Error(`public-log-guard self-test failed: ${JSON.stringify(input)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
}
