/* The fabric series the OWNER dictated by hand, and which no derivation rule
   may re-derive.
   NO SHEBANG — this is a lib, imported by scripts and by tests.

   WHY THIS FILE EXISTS. `seed-owner-fabric-catalogue.mjs` drove twelve series
   to the owner's own list on 2026-08-11, colour names included. Two scripts
   have to know that list and stay out of their way:

     normalize-fabric-codes.mjs   skips them (it held its own copy)
     tidy-fabric-descriptions.mjs did NOT know about them at all

   The consequence of the second one was measured, not guessed: the 2026-08-14
   production plan reported 78 Fabric Converter rows and 171 selling-library
   rows as `code is not canonical (would be DE-01) — fix the CODE first`. Every
   one of those is the owner's own spelling. The run changed nothing (WOULD
   REWRITE: 0), so nothing was damaged — but a report that lists 249 correct
   rows as problems is how a real one stops being noticed.

   ONE LIST, NOT TWO. A second copy is how two scripts come to disagree about
   what the catalogue is, which is the same shape as the five matchers #1893
   pulled back together. Import it; do not re-type it. */

/** The twelve series seed-owner-fabric-catalogue.mjs owns. */
export const CATALOGUE_SERIES = new Set([
  "ZL", "MODENZA", "BO315", "NX", "GD2502", "AM275",
  "CH141", "M2402", "ORION", "TR", "DE", "HR805",
]);

/** Does this parsed code belong to a series the owner dictated?
 *  Takes the PARSED series (from lib/fabric-code.mjs), never a raw string —
 *  "DE01" and "DE-01" must answer the same, and only the parser knows that. */
export const isCatalogueSeries = (series) =>
  CATALOGUE_SERIES.has(String(series ?? "").trim().toUpperCase());
