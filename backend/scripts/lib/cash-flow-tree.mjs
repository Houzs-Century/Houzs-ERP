// cash-flow-tree — the owner's Cash Flow tree, built from the chart of
// accounts the way his two workbooks read it (2026-09-18: 2990s "Monthly
// Cshflw" / "Cshflw Summary" and Houzs "Cash Flow — Receipt & Payment").
//
// The shape (one tree, both companies; a group a company never uses is
// unticked for it):
//   CASH IN (In)                       Total Cash In
//     Deposit received · (-) Refund to customer · Sales & trade receipts
//   OPERATIONS OUTFLOWS (Out)          Total operations outflows
//     Cost of funds (purchases, creditors, transport, commission)
//     Exhibition & roadshow (Houzs)  · Showrooms · Warehouse (Houzs)
//     General expense (salary, rental, homestay, marketing, professional, office)
//   — Net operation surplus / (deficit)
//   OTHER INCOME (In) · TAXATION (Out) · FINANCE COST (Out)
//   — Cash Surplus / (Deficit) after others
//   FUNDING IN / (OUT) (In)            Net Funding In / (Out)
//     Shareholders fund · Deposit (incurred) / repay · CAPEX · FD
//     Loan from related party · Repayment to related party
//     Loan & HP drawdown · Loan & HP repayment
//   TRANSFERS BETWEEN OWN ACCOUNTS (In) Net transfers
//
// A line is Net (money in less money out, oriented to its side) unless the
// workbook wants the two directions apart: a customer's money in sits under
// Deposit received and its money out under (-) Refund to customer; a loan's
// drawdown and repayment are two groups. An account no rule names lands in
// Office & admin, and is listed so the owner sees it.
//
// Pure: no database, no clock. The seeding script and its test both call it.

const HOUZS_ONLY = [2]; // hidden for 2990 HOME (company 2)

/** The rules, first match wins. `codes` are exact codes or prefixes ending in '*'. */
const GROUPS = [
  { id: 'cf:in:deposit', flow: 'in', codes: ['300-0000', '326-*', '327-0000', '400-0001', '509-0000', '399-9999', '440-0000'] },
  { id: 'cf:in:sales', flow: 'net', codes: ['500-*', '501-*', '502-*', '503-*', '510-*', '520-*', '305-0000', '370-0000'] },
  { id: 'cf:ops:cost:purchases', flow: 'net', codes: ['600-*', '601-*', '602-*', '604-*', '610-*', '612-*', '613-*', '615-*', '619-*', '620-*', '330-0000', '410-0080'] },
  { id: 'cf:ops:cost:ap', flow: 'net', codes: ['400-0000', '405-*', '406-*'] },
  { id: 'cf:ops:cost:transport', flow: 'net', codes: ['603-*', '900-T004', '900-T005', '900-T006', '900-T007', '900-T008', '900-T015', '900-T017', '900-T018', '900-T019', '900-T020', '900-T021', '900-T022', '900-T023', '900-T024', '900-T025', '900-T026', '900-T027', '900-T028', '900-T029', '900-T034', '900-T036', '900-U006', '900-U007', '900-U008', '900-U009', '900-U010', '900-U011', '900-P006', '900-P007', '900-P009', '900-P010', '900-P014', '900-P015'] },
  { id: 'cf:ops:cost:commission', flow: 'net', codes: ['900-C003', '410-0070', '900-S700', '900-R041', '360-0050'] },
  { id: 'cf:ops:exh', flow: 'net', codes: ['900-R031', '900-R032', '900-A003', '900-A008', '900-A010', '360-0010', '900-B003', '900-B005', '900-H003', '900-T002', '900-E002', '900-E004', '900-E005', '900-E006', '900-E011', '900-S011', '900-L003', '900-T030', '900-T031', '900-T032', '900-T033', '900-T035'] },
  { id: 'cf:ops:showroom', flow: 'net', codes: ['900-R006', '900-R007', '900-R008', '900-R009', '900-R048', '900-A006', '900-A007', '900-A014', '900-E008', '900-U003', '900-S001', '900-W005', '900-T012', '900-C002'] },
  { id: 'cf:ops:warehouse', flow: 'net', codes: ['900-R002', '900-R003', '900-R004', '900-R005', '900-R042', '900-R046', '900-E009', '900-E012', '900-E013', '900-E014', '900-H004', '900-U001', '900-W007', '900-W008', '900-W009', '900-T013', '900-T014'] },
  { id: 'cf:ops:general:salary', flow: 'net', codes: ['410-0010', '410-0020', '410-0030', '410-0040', '410-0050', '900-S010', '900-S100', '900-S200', '900-S300', '900-S400', '900-S500', '900-S600', '900-S800', '900-D002', '900-D003', '900-D100', '900-D200', '900-D300', '900-D400', '900-D500', '900-M002', '360-0030', '360-0040'] },
  { id: 'cf:ops:general:rental', flow: 'net', codes: ['900-R001', '900-R030', '900-R040', '900-R044', '900-R045', '900-R047'] },
  { id: 'cf:ops:general:homestay', flow: 'net', codes: ['900-R01*', '900-R020', '900-R021', '900-R043', '900-H001', '900-H002', '900-H005', '900-H010', '900-H011', '900-H012', '900-U004', '900-E010'] },
  { id: 'cf:ops:general:marketing', flow: 'net', codes: ['900-A002', '900-A004', '900-A005', '900-A009', '900-A015', '900-A016', '900-M001'] },
  { id: 'cf:ops:general:professional', flow: 'net', codes: ['900-A001', '900-A011', '900-B002', '900-D005', '900-I001', '900-L001', '900-P003', '900-P013', '900-S002', '900-P011', '410-0090', '410-0100'] },
  { id: 'cf:ops:general:office', flow: 'net', codes: ['900-0000', '900-O001', '900-A012', '900-A013', '900-B001', '900-B004', '900-D001', '900-D004', '900-D006', '900-E001', '900-E003', '900-E007', '900-G001', '900-I002', '900-I003', '900-L002', '900-P001', '900-P002', '900-P005', '900-P008', '900-P012', '900-S003', '900-S004', '900-S005', '900-S008', '900-T001', '900-T003', '900-T010', '900-T011', '900-U002', '900-U012', '900-W001', '900-W002', '900-W003', '900-W004', '900-W006', '919-*', '922-*', '926-*', '930-*', '931-*', '933-*', '937-*', '938-*', '946-*', '947-*', '360-0000', '410-0000', '410-0060', '490-*'] },
  { id: 'cf:other-income', flow: 'net', codes: ['530-*', '540-*', '550-*', '560-*', '570-*', '580-*', '590-*', '591-*', '592-*', '598-*', '599-*', '700-*'] },
  { id: 'cf:tax', flow: 'net', codes: ['950-*', '390-*', '480-*'] },
  { id: 'cf:finance', flow: 'net', codes: ['900-F001', '900-H015', '900-L004', '900-T009', '451-*', '460-H*', '465-*'] },
  { id: 'cf:funding:capital', flow: 'net', codes: ['100-*', '150-*', '151-*'] },
  { id: 'cf:funding:deposit', flow: 'net', codes: ['340-*', '420-*'] },
  { id: 'cf:funding:capex', flow: 'net', codes: ['200-*', '201-*', '202-*', '203-*', '204-*', '205-*', '206-*', '207-*', '210-*', '250-*'] },
  { id: 'cf:funding:fd', flow: 'net', codes: ['380-*'] },
  { id: 'cf:funding:related', flow: 'in', codes: ['350-*', '351-*', '430-*'] },
  { id: 'cf:funding:loan', flow: 'in', codes: ['460-*', '450-*'] },
  { id: 'cf:funding:loan-out', flow: 'net', codes: ['360-0020', '360-0060'] },
  { id: 'cf:transfers', flow: 'net', codes: ['310-*', '320-*', '321-*', '322-*', '323-*', '324-*', '325-*'] },
];
const FALLBACK = 'cf:ops:general:office';

/** Where an account's OTHER direction goes when the two are kept apart. */
const OUT_TWIN = {
  'cf:in:deposit': 'cf:in:refund',
  'cf:funding:related': 'cf:funding:related-out',
  'cf:funding:loan': 'cf:funding:loan-out',
};

const matches = (pattern, code) => (pattern.endsWith('*') ? code.startsWith(pattern.slice(0, -1)) : code === pattern);

/** The group an account belongs to, by the first rule naming it. */
export function groupOf(code) {
  for (const g of GROUPS) if (g.codes.some((p) => matches(p, code))) return { id: g.id, flow: g.flow };
  return { id: FALLBACK, flow: 'net', unmatched: true };
}

/* The tree's skeleton: labels, sides, subtotal names, who sees what. */
const cat = (id, label, children, extra = {}) => ({ kind: 'category', id, label, ...extra, children });
const sub = (id, label) => ({ kind: 'subtotal', id, label });

function skeleton() {
  return [
    cat('cf:in', 'CASH IN', [
      cat('cf:in:deposit', 'Deposit received', []),
      cat('cf:in:refund', '(-) Refund to customer', []),
      cat('cf:in:sales', 'Sales & trade receipts', []),
    ], { flow: 'in', totalLabel: 'Total Cash In' }),
    cat('cf:ops', 'OPERATIONS OUTFLOWS', [
      cat('cf:ops:cost', 'Cost of funds', [
        cat('cf:ops:cost:purchases', 'Purchases', []),
        cat('cf:ops:cost:ap', 'Accounts payable & creditors', []),
        cat('cf:ops:cost:transport', 'Transport & logistics', []),
        cat('cf:ops:cost:commission', 'Commission', []),
      ]),
      cat('cf:ops:exh', 'Exhibition & roadshow expense', [], { hiddenFor: HOUZS_ONLY }),
      cat('cf:ops:showroom', 'Showrooms expense', []),
      cat('cf:ops:warehouse', 'Warehouse expense', [], { hiddenFor: HOUZS_ONLY }),
      cat('cf:ops:general', 'General expense', [
        cat('cf:ops:general:salary', 'Salary & related', []),
        cat('cf:ops:general:rental', 'Rental - office & others', []),
        cat('cf:ops:general:homestay', 'Homestay, hostel & accommodation', []),
        cat('cf:ops:general:marketing', 'Advertising & marketing', []),
        cat('cf:ops:general:professional', 'Professional & statutory', []),
        cat('cf:ops:general:office', 'Office & admin', []),
      ]),
    ], { flow: 'out', totalLabel: 'Total operations outflows' }),
    sub('cf:sub:ops', 'Net operation surplus / (deficit)'),
    cat('cf:other-income', 'OTHER INCOME', [], { flow: 'in', totalLabel: 'Total other income' }),
    cat('cf:tax', 'TAXATION', [], { flow: 'out', totalLabel: 'Total taxation' }),
    cat('cf:finance', 'FINANCE COST', [], { flow: 'out', totalLabel: 'Total finance cost' }),
    sub('cf:sub:after-others', 'Cash Surplus / (Deficit) after others'),
    cat('cf:funding', 'FUNDING IN / (OUT)', [
      cat('cf:funding:capital', 'Shareholders fund', []),
      cat('cf:funding:deposit', 'Deposit (incurred) / repay', []),
      cat('cf:funding:capex', 'Capital expenditure (CAPEX)', []),
      cat('cf:funding:fd', 'FD placement / (withdrawn)', []),
      cat('cf:funding:related', 'Loan from related party & directors', []),
      cat('cf:funding:related-out', 'Repayment / loan to related party & directors', []),
      cat('cf:funding:loan', 'Loan & HP drawdown', []),
      cat('cf:funding:loan-out', 'Loan & HP repayment', []),
    ], { flow: 'in', totalLabel: 'Net Funding In / (Out)' }),
    cat('cf:transfers', 'TRANSFERS BETWEEN OWN ACCOUNTS', [], { flow: 'in', totalLabel: 'Net transfers' }),
  ];
}

const index = (items, into = new Map()) => {
  for (const it of items) if (it.kind === 'category') { into.set(it.id, it); index(it.children, into); }
  return into;
};

/**
 * @param {Array<{code: string, name?: string}>} accounts — the chart, both companies (codes unique)
 * @returns {{ layout: object, mapping: Array<{code: string, name: string, group: string, flow: string, unmatched: boolean}>, unmatched: string[] }}
 */
export function buildCashFlowTree(accounts) {
  const tree = skeleton();
  const byId = index(tree);
  const mapping = [];
  const unmatched = [];
  const seen = new Set();
  for (const a of [...accounts].sort((x, y) => x.code.localeCompare(y.code))) {
    const code = String(a.code).trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const g = groupOf(code);
    const home = byId.get(g.id);
    if (!home) throw new Error(`rule names a group the skeleton lacks: ${g.id}`);
    home.children.push({ kind: 'account', code, flow: g.flow });
    const twin = OUT_TWIN[g.id];
    if (twin) byId.get(twin).children.push({ kind: 'account', code, flow: 'out' });
    mapping.push({ code, name: a.name ?? '', group: g.id, flow: g.flow, unmatched: Boolean(g.unmatched) });
    if (g.unmatched) unmatched.push(code);
  }
  return { layout: { version: 1, blocks: { accounts: tree } }, mapping, unmatched };
}

/** The labels down the tree, for a plan print or a test. */
export function outline(items, depth = 0, out = []) {
  for (const it of items) {
    if (it.kind === 'account') continue;
    const leaves = it.kind === 'category' ? countLeaves(it.children) : 0;
    out.push(`${'  '.repeat(depth)}${it.kind === 'subtotal' ? '— ' : ''}${it.label}${it.flow ? ` [${it.flow.toUpperCase()}]` : ''}${it.totalLabel ? ` → ${it.totalLabel}` : ''}${it.hiddenFor ? ` (hidden for ${it.hiddenFor.join(',')})` : ''}${it.kind === 'category' ? ` · ${leaves} line${leaves === 1 ? '' : 's'}` : ''}`);
    if (it.kind === 'category') outline(it.children, depth + 1, out);
  }
  return out;
}

export const countLeaves = (items) => items.reduce((n, it) => n + (it.kind === 'account' ? 1 : it.kind === 'category' ? countLeaves(it.children) : 0), 0);
export const topIds = (layout) => (layout?.blocks?.accounts ?? []).map((it) => it.id);
