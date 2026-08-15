// ----------------------------------------------------------------------------
// The State / City / Postcode cascade, in ONE place.
//
// The owner's rule for every address surface: "它可以由上往下，也可以由下往上" —
// pick a State and City/Postcode narrow to it, OR pick a City or a Postcode
// first and let the State fill itself in. Both directions, everywhere.
//
// This module exists because that wiring was about to be hand-copied a fourth
// time. SalesOrderNew, MobileNewSO and SalesOrderDetail each grew their own
// cityChoices / postcodeChoices / applyCityReverse / applyPostcodeReverse, and
// the three copies had ALREADY drifted before a fourth was written:
//   - SalesOrderNew called setPostcode('') from the JSX and resolved the state
//     inside applyCityReverse; SalesOrderDetail did both in one setForm.
//   - All three fell back to the NATIONWIDE postcode pool whenever City was
//     blank, so a picked State narrowed City but not Postcode.
// Eight more customer-address forms had no reverse resolution at all — City
// disabled until State, Postcode until City. Enumerate the callers rather than
// trusting a count written here:
//   grep -rl "lib/address-cascade" frontend/src
// A cascade that is hand-copied per form is how the copies drift, so the rules
// live here and the forms call in.
//
// The three pick* functions are PURE and return the whole triple, because the
// call sites do not agree on a state shape: some hold three useState atoms,
// some hold one `form` object. Returning the triple lets an object-shaped form
// write it in ONE setForm — which matters, because the State picker's own
// handler exists to CLEAR the cascade, so routing a reverse-resolved State
// through it would wipe the value the operator just picked.
//
// AMBIGUITY IS REFUSED, NEVER GUESSED. resolveCityState returns null for a city
// that sits under more than one state and resolvePostcode returns null rather
// than pick a side; both are preserved here — an unresolved pick leaves State
// alone for the operator instead of filling in a wrong one.
// ----------------------------------------------------------------------------
import { useMemo } from 'react';
import {
  allCities,
  allPostcodes,
  citiesInState,
  distinctStates,
  postcodesForCity,
  postcodesInCity,
  postcodesInState,
  resolveCityState,
  resolvePostcode,
  type LocalityRow,
} from './localities-queries';

export interface AddressTriple {
  state: string;
  city: string;
  postcode: string;
}

/* City options. With a State picked this is the state's cities (top-down);
   with no State it is the cross-state pool, so the operator can start here. */
export const cityOptionsFor = (rows: LocalityRow[], state: string): string[] =>
  (state ? citiesInState(rows, state) : allCities(rows));

/* Postcode options, narrowed by whatever IS known — in order:
   both  -> the city's postcodes in that state
   state -> every postcode in the state (top-down keeps narrowing)
   city  -> the postcodes of that city name, whichever states carry it
   neither -> the whole pool, so the operator can start from a postcode. */
export const postcodeOptionsFor = (rows: LocalityRow[], state: string, city: string): string[] => {
  if (state && city) return postcodesInCity(rows, state, city);
  if (state) return postcodesInState(rows, state);
  if (city) return postcodesForCity(rows, city);
  return allPostcodes(rows);
};

/* Picking a State RESETS the rest of the cascade — a city/postcode chosen under
   the old state is not valid under the new one. This is the one handler that is
   deliberately destructive, which is exactly why the reverse resolvers below
   must never route through it. */
export const pickState = (nextState: string): AddressTriple =>
  ({ state: nextState, city: '', postcode: '' });

/* Picking a City clears the Postcode (it belonged to the previous city) and
   back-fills the State when — and only when — the city names one unambiguously.
   An already-picked State is left alone unless the city contradicts it. */
export const pickCity = (
  rows: LocalityRow[],
  current: AddressTriple,
  nextCity: string,
): AddressTriple => {
  const resolved = nextCity ? resolveCityState(rows, nextCity) : null;
  return {
    state: resolved && resolved !== current.state ? resolved : current.state,
    city: nextCity,
    postcode: '',
  };
};

/* Picking a Postcode back-fills State AND City. A Malaysian 5-digit code maps
   to one locality, so this is the shortest path from "the customer read me a
   postcode" to a complete address. The postcode itself is always kept — it is
   what the operator just chose. */
export const pickPostcode = (
  rows: LocalityRow[],
  current: AddressTriple,
  nextPostcode: string,
): AddressTriple => {
  const resolved = nextPostcode ? resolvePostcode(rows, nextPostcode) : null;
  return {
    state: resolved?.state && resolved.state !== current.state ? resolved.state : current.state,
    city: resolved?.city && resolved.city !== current.city ? resolved.city : current.city,
    postcode: nextPostcode,
  };
};

/* Placeholders that TELL the operator the field is a valid starting point. The
   old copy read "— pick state first", which described a gate that no longer
   exists and was the only thing on screen saying the cascade was one-way. */
export const cityPlaceholder = (state: string): string =>
  (state ? 'Pick city' : 'Pick city — State fills in');

export const postcodePlaceholder = (state: string, city: string): string => {
  if (city) return 'Pick postcode';
  if (state) return 'Pick postcode — City fills in';
  return 'Pick postcode — State and City fill in';
};

/* The three option lists, memoised. Every form needs the same three and they
   all depend on the same two values, so the memo keys live here rather than in
   one copy per form, each free to forget a dependency. */
export const useAddressCascade = (
  rows: LocalityRow[],
  state: string,
  city: string,
): { states: string[]; cities: string[]; postcodes: string[] } => {
  const states = useMemo(() => distinctStates(rows), [rows]);
  const cities = useMemo(() => cityOptionsFor(rows, state), [rows, state]);
  const postcodes = useMemo(() => postcodeOptionsFor(rows, state, city), [rows, state, city]);
  return { states, cities, postcodes };
};
