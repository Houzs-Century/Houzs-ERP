
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
