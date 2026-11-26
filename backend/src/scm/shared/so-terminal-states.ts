
/** SO statuses that no longer create demand: the goods have left, the order is
 *  closed or cancelled, or it was never committed (DRAFT). */
export const SO_TERMINAL_STATES = [
  'CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT',
] as const;

/** The same set as a PostgREST `in` list — `.not('status','in', ...)`. */
export const SO_TERMINAL_STATES_PGREST = `(${SO_TERMINAL_STATES.join(',')})`;

export type SoTerminalState = (typeof SO_TERMINAL_STATES)[number];
