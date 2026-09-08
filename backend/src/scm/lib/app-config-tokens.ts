// ----------------------------------------------------------------------------
// app-config-tokens — what "off" and "everyone" spell, for the operational
// switches in scm.app_config.
//
// ONE HOME for one question. `scm.write_freeze` and `scm.migrated_so_lock` are
// different grammars on purpose — the freeze carries a `- <areas>` clause and
// the migrated lock refuses one — but they answer to the SAME operator, in the
// same table, one row apart, and "did I turn it off?" must not have two answers.
// An operator who types `false` into one and finds it means OFF has learned a
// fact about the other, and that has to keep being true.
//
// The cost of divergence is not a crash. It is a switch that reads as ON when
// somebody meant OFF, on documents a cutover is in the middle of. That is why
// this is a shared module and not two Sets that happen to match today.
//
// Case and surrounding whitespace are the CALLER's problem: both parsers lower
// and trim before they get here, because both also have to do it for the parts
// of their value this file says nothing about.
// ----------------------------------------------------------------------------

/** Spellings of "nothing is frozen / nothing is locked". */
export const OPEN_TOKENS: ReadonlySet<string> = new Set(['', 'off', '0', 'false']);

/** Spellings of "every company". */
export const ALL_TOKENS: ReadonlySet<string> = new Set(['all', 'true']);
