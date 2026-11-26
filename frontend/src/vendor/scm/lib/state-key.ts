// state-key — compare Malaysian state names the way the ERP's documents do.
// Pure (no fetch, no React): split out of localities-queries.ts so the printed
// address rule (order-address.ts) can be bundled by the Worker too.

/* Orders imported from AutoCount or made on the old PMS carry the state as
   "PENANG" / "KL" / "N.S." while my_localities spells it "Pulau Pinang" /
   "Kuala Lumpur" / "Negeri Sembilan". An exact compare gave the stored state no
   cities and no postcodes ("No cities seeded"), so the operator could not fix
   the order. Compare on a key that folds case, dots and these aliases. Mirrors
   backend/src/scm/lib/canonical-state.ts; the key side also folds
   "Wilayah Persekutuan ..." because the dataset is not uniform about it. */
const STATE_ALIAS: Record<string, string> = {
  PENANG: 'PULAU PINANG', 'P PINANG': 'PULAU PINANG',
  KL: 'KUALA LUMPUR', 'WP KUALA LUMPUR': 'KUALA LUMPUR', 'W P KUALA LUMPUR': 'KUALA LUMPUR',
  'WILAYAH PERSEKUTUAN KUALA LUMPUR': 'KUALA LUMPUR',
  'WP LABUAN': 'LABUAN', 'W P LABUAN': 'LABUAN', 'WILAYAH PERSEKUTUAN LABUAN': 'LABUAN',
  'WP PUTRAJAYA': 'PUTRAJAYA', 'W P PUTRAJAYA': 'PUTRAJAYA', 'WILAYAH PERSEKUTUAN PUTRAJAYA': 'PUTRAJAYA',
  NS: 'NEGERI SEMBILAN', 'N S': 'NEGERI SEMBILAN', 'N SEMBILAN': 'NEGERI SEMBILAN',
  MALACCA: 'MELAKA', TRENGGANU: 'TERENGGANU',
};
export const stateKey = (state: string): string => {
  const k = state.trim().toUpperCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  return STATE_ALIAS[k] ?? k;
};
export const sameState = (a: string, b: string): boolean => stateKey(a) === stateKey(b);
