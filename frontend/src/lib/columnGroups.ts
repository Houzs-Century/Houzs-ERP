/**
 * Column groups for the Columns drawer, inferred from a column's key + label.
 *
 * Owner 2026-08-02: 全部 column 都要像 sales order column 那样分类. There are
 * ~500 distinct columns across the app's 66 list pages, and hand-annotating
 * each one would be 66 files to edit, 66 chances to drift, and a new column
 * silently ungrouped every time someone adds one.
 *
 * So the group is DERIVED, from one table, in one place. A page can still
 * override any column with an explicit `group` — Sales Orders does, because
 * its 44 columns were sorted by hand first and that hand-sort is better than
 * anything derivable. Explicit always wins.
 *
 * ── HOW THE RULES WERE BUILT ──────────────────────────────────────────────
 * Not from imagination: the app's actual column vocabulary was extracted from
 * every list page and the families below are what that vocabulary falls into.
 * `columnGroups.test.ts` re-extracts it and fails if coverage drops, so a new
 * family of columns can't quietly land in "Other" en masse.
 *
 * Order matters — the first matching rule wins, and the more specific families
 * (cost/margin before money, delivery dates before dates) come first.
 */

export const COLUMN_GROUPS = {
  basic: "Basic",
  party: "Customer & contact",
  amounts: "Amounts",
  costs: "Cost & margin",
  logistics: "Logistics",
  stock: "Stock & quantity",
  people: "People & admin",
  other: "Other",
} as const;

export type ColumnGroupName = (typeof COLUMN_GROUPS)[keyof typeof COLUMN_GROUPS];

interface Rule {
  group: ColumnGroupName;
  /** Matched against `key label`, lowercased. */
  any: RegExp;
}

/* Each pattern below appears verbatim in the app's real column vocabulary.
   Keep them anchored on words, not fragments: `\bcost\b` and not `cost`, or
   "Costa Rica" would be a cost column. */
const RULES: Rule[] = [
  // ── Cost & margin — BEFORE money, because "Total Cost" is a cost first. ──
  {
    group: COLUMN_GROUPS.costs,
    any: /\b(cost|cogs|margin|gp|profit|commission|variance|markup)\b|\bnp \(rm\)|cost_centi|_cost\b/,
  },
  // ── Money on the document ────────────────────────────────────────────────
  {
    group: COLUMN_GROUPS.amounts,
    any: /\b(amount|total|subtotal|tax|discount|disc|paid|balance|deposit|refund|refunded|credit|debit|price|rate|currency|curr|value|revenue|sales|income|outstanding|owed|payment|billed|invoice|invoiced|rental|rent|due|overdue|aging|age|bucket|finances|account|merchandise|mattress|sofa|bedframe|accessories|specials)\b|_centi\b|\(rm\)/,
  },
  // ── Getting it made, moved and delivered ─────────────────────────────────
  {
    group: COLUMN_GROUPS.logistics,
    any: /\b(delivery|deliveries|deliver|delivered|dispatch|shipout|carrier|tracking|eta|arrival|arrives|departure|driver|helper|lorry|vehicle|plate|fleet|registration|trip|route|zone|warehouse|whse|rack|shelf|venue|location|transport|pickup|pickups|scheduled|unscheduled|sched|processing date|collected|setup|dismantle|lift booking|do|transfer to|transfer from|stock status|expected|earliest|latest|when|time|days left|work days|repair days|utilisation|covers|areas)\b/,
  },
  // ── What there is, and how much of it ────────────────────────────────────
  {
    group: COLUMN_GROUPS.stock,
    any: /\b(qty|quantity|uom|stock|on hand|available|reserved|remaining|ordered|incoming|received|returned|moq|batch|lot|barcode|sku|item|items|product|model|allocations|condition|serial|components|fabrics|size|dimension|divan height|leg height|unit|spare|categories|brands|brandings)\b/,
  },
  // ── Who it is for, and how to reach them ─────────────────────────────────
  {
    group: COLUMN_GROUPS.party,
    any: /\b(customer|debtor|supplier|creditor|party|payee|contact|phone|email|address|city|postcode|state|country|website|house type|building type|customer type|referral)\b/,
  },
  // ── Staff, roles, the org ────────────────────────────────────────────────
  {
    group: COLUMN_GROUPS.people,
    any: /\b(salesperson|agent|pic|assignee|assigned|owner|approver|requested by|created by|invited|member|role|position|department|division|reports to|direct reports|joined|last seen|presence|team|organizer|in house|outsourced|lead|by)\b/,
  },
  // ── The document itself ──────────────────────────────────────────────────
  {
    group: COLUMN_GROUPS.basic,
    any: /\b(doc|no\.?|number|ref|reference|date|dates|status|stage|type|kind|code|name|title|label|description|remark|remarks|note|notes|reason|created|updated|company|brand|branding|project|category|group|series|source|progress|priority|rating|active|enabled|default|id|photo|photos|lines|case|cases|closed|breached|follow up|message|emailed|expires|scope|from|to|check|accepted|gaps|main|actions|history|metrics|maintenance|calendar|month|custom|all)\b/,
  },
];

/**
 * The group a column belongs to, or undefined when nothing matches — the
 * caller then leaves it ungrouped rather than inventing a home for it.
 *
 * Pure and cheap: called once per column per drawer render.
 */
export function inferColumnGroup(key: string, label: string): ColumnGroupName | undefined {
  const haystack = `${key} ${label}`.toLowerCase().replace(/[_.:-]/g, " ");
  for (const rule of RULES) {
    if (rule.any.test(haystack)) return rule.group;
  }
  return undefined;
}
