const doStatusList = {
  selector: "ArrayExpression[elements.length>2] > Literal[value='IN_TRANSIT']",
  message:
    'Hand-typed DO status list. Import DO_SHIPPED_STATES / DO_STOCK_OUT_STATES / ' +
    'DO_STATUSES / DO_PRESHIP_STATES from scm/shared/do-shipped-states (backend) — ' +
    'the .mjs audits use scripts/lib/do-shipped-states.mjs, pinned by ' +
    'tests/doShippedStatesMirror.test.ts. This list was hand-copied into eleven ' +
    'files and two of the copies had already drifted apart. If this array is a ' +
    'genuinely different partition, disable this line and say which one.',
};

const financeKeyListSnake = {
  selector:
    "ArrayExpression[elements.length>2] > Literal[value=/^(unit_cost_centi|line_cost_centi|line_margin_centi|total_cost_centi|total_margin_centi|margin_pct_basis|cost_price_sen)$/]",
  message:
    'Hand-declared finance-key list. scm/lib/finance-keys.ts is the one vocabulary ' +
    '(SO_FINANCE_KEYS / SO_ITEM_FINANCE_KEYS / PRODUCT_FINANCE_KEYS / ' +
    'AUDIT_FINANCE_FIELDS). Six routes re-declared it after that file said not to, ' +
    'and every copy drifted; #574/#600/#625/#632 are one bug seen four times. If ' +
    'this really is a per-document subset, disable this line and state which ' +
    'columns THIS document has that the shared list does not.',
};

const financeKeyListCamel = {
  selector:
    "ArrayExpression[elements.length>2] > Literal[value=/^(unitCostCenti|lineCostCenti|lineMarginCenti|depositCenti)$/]",
  message:
    'Hand-declared camelCase finance-key list — the escape hatch finance-keys.ts ' +
    'warns about in writing ("a camelCase surface would escape this list"), and the ' +
    'mechanism behind the SO audit-log cost leak. Import AUDIT_FINANCE_FIELDS / ' +
    'stripAuditFinance from scm/lib/finance-keys.',
};

const asNever = {
  selector: 'TSAsExpression > TSNeverKeyword',
  message:
    '`as never` turns off the check that was about to help. A hand-written option ' +
    'list cast past its enum shipped a form that refused every value it offered ' +
    '(3PL lorry types, 2026-08-02) — typecheck, 960 tests and the build were all ' +
    'green. Type the value, or import the shared constant that already types it.',
};

export { houzsPlugin } from './houzs-plugin.mjs';

export const restrictedSyntax = [doStatusList, financeKeyListSnake, financeKeyListCamel, asNever];

/** Every rule is `warn`: scripts/lint-ratchet.mjs is the gate, with per-file ceilings that only fall. */
export const sharedRules = {
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-unnecessary-condition': ['warn', { allowConstantLoopConditions: true }],
  '@typescript-eslint/no-explicit-any': 'warn',
  'no-restricted-syntax': ['warn', ...restrictedSyntax],
  'houzs/no-prose-comments': 'warn',
  'houzs/no-imperative-timers': 'warn',
};
