// The ONE sofa special-order mapper: an AutoCount special phrase -> the picker
// codes it means. Extracted verbatim from backfill-sofa-special-orders.mjs,
// which is where the owner's rulings were written down; the audit that has to
// agree with that backfill is the second consumer, and a second hand-copy of
// these rules is exactly the drift this repo keeps paying for (see
// lib/parse-bedframe.mjs's header for the last two rounds of it).
//
// Every rule resolves its target against the LIVE scm.special_addons read that
// the caller passes in, so a rule whose code is not in the database maps to
// nothing rather than inventing a code.
export const K = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
// same identity the parser dedupes on: letters and digits only, nilon = nylon
export const skey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NILON/g, "NYLON");
// match on words, so "BACK REST", "BACKREST" and "back-rest" are one thing
export const flat = (s) => " " + String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";

/* Owner rulings, each one the reason the rule exists.

   nylon 和 umbrella fabric 一样的                  -> Nylon Fabric
   "fully cover to floor no leg", "fully cover replace the leg" and
   "extend to floor with 1 inch leg" 都是 under no leg
                                        -> Seat Base Fully Cover with no Leg
   "after push back align to seat"      -> Seat Behind Extend 5"
   "seat cushion add height 1 inch"     -> NO code on purpose ("不要太多选项"),
                                           it belongs in the free text
   Altay Leg left the Specials picker for the sofa leg pool, so a leg-change
   phrase is deliberately NOT mapped here either.

   `no` is the negation guard: "request to normal leg and not fully cover" says
   the opposite of the code it would otherwise match. */
export const RULES = [
  { code: 'Nylon Fabric',
    yes: (s) => /\b(nylon|nilon|umbrella|umb|nilonn?)\b/.test(s) },

  { code: 'Seat Base Fully Cover with no Leg',
    no: (s) => /\bnot fully cover|\bnormal leg\b/.test(s),
    yes: (s) => (/\bfully cover(ed)?\b/.test(s) && /\bno leg\b|\bto floor\b|\breplace the leg\b|\bchange for the leg\b/.test(s))
      || (/\breplace the leg\b/.test(s) && /\bfully cover(ed)?\b/.test(s))
      || (/\bextend to floor\b/.test(s) && /\bleg\b/.test(s))
      || /\bno leg\b/.test(s) },

  { code: 'Seat Behind Extend 5"',
    yes: (s) => /\bpush back\b/.test(s) && /\balign to seat\b/.test(s) },

  { code: 'Wooden Arm',
    yes: (s) => /\bwood\w*\b/.test(s) && /\barm\w*\b|\bplate\b/.test(s) },

  /* "notch" is the stitched dimple in a seat cushion; every one of these says
     do not put one there. Flagged in the report as an inferred mapping. */
  { code: 'No notch on Seat Cushion',
    no: (s) => /\bplane\b|\bplain\b/.test(s),
    yes: (s) => /\bno\b/.test(s) && /\bstitch\w*|\bstich\w*|\bholes?\b|\bnotch\b/.test(s)
      && /\bsit\w*|\bseat\w*|\bcushion\b|\bstitch\w*|\bstich\w*/.test(s) },

  // owner named this code from this exact phrase (tidy-sofa-special-addons.mjs)
  { code: 'Seat Cushion No Notch and Plain',
    yes: (s) => /\bno line\b/.test(s) && /\bplane\b|\bplain\b/.test(s) },

  { code: 'Seat Firmer',
    no: (s) => /\bless firm\b|\bsofter\b|\bmore soft\b|\bback\b/.test(s),
    yes: (s) => /\bseat\w*\b|\bsitting\b/.test(s) && /\bfirmer\b|\bharder\b|\bdo hard\b/.test(s) },

  { code: 'Backcushion Firmer',
    no: (s) => /\bless firm\b|\bsofter\b|\bmore soft\b|\bseat\b/.test(s),
    yes: (s) => /\bback\b/.test(s) && /\bfirmer\b|\bharder\b/.test(s) },

  { code: 'Seat and Backcushion Firmer',
    no: (s) => /\bless firm\b|\bsofter\b|\bmore soft\b/.test(s),
    yes: (s) => /\bseat\w*\b/.test(s) && /\bback\b/.test(s) && /\bfirmer\b|\bharder\b/.test(s) },

  { code: 'Separate Backrest Packing',
    yes: (s) => /\bback ?rest\b|\bback cushion\b/.test(s) && /\bseparate\b/.test(s) },

  { code: 'No bracket', yes: (s) => /\bno bracket\b/.test(s) },
  { code: 'Short Backrest', yes: (s) => /\bshort back ?rest\b/.test(s) },
  { code: 'Seat Add 1ft', yes: (s) => /\bseat\b/.test(s) && /\badd 1 ?f?t\b|\badd one foot\b/.test(s) },
  { code: 'Seat Behind Extend 4"', yes: (s) => /\bseat behind\b/.test(s) && /\bextend 4\b/.test(s) },
  { code: '5537 Backrest', yes: (s) => /\b5537\b/.test(s) && /\bback ?rest\b/.test(s) },
  { code: '5540 Backrest', yes: (s) => /\b5540\b/.test(s) && /\bback ?rest\b/.test(s) },
];

/* The back-cushion swap family. In these slips "backrest" and "back cushion"
   are the same part - the picker carries exactly one code per model number -
   so both wordings route to the model's code. 5537/5540 are handled above as
   their own products and must be tested before this. */
export const CUSHION_MODELS = [
  ["8030", "Change 8030 Backcushion"],
  ["9028", "change to 9028 back cushion"],
  ["9050", "change to 9050 back cushion"],
  ["9058", "change to 9058 back cushion"],
  ["5535", "change to 5535 back cushion"],
];

/* live: K(code|label) -> the real scm.special_addons code, built by the caller
   from the SOFA-category rows it just read. */
export function mapPhrase(raw, live) {
  const s = flat(raw);
  const out = new Set();
  for (const r of RULES) {
    if (r.no && r.no(s)) continue;
    if (!r.yes(s)) continue;
    const code = live.get(K(r.code));
    if (code) out.add(code);
  }
  if (/\bback ?rest\b|\bback ?cushion\b/.test(s)) {
    for (const [model, want] of CUSHION_MODELS) {
      // "9058 sofa backrest change 9028" names the sofa first: take the model
      // being changed TO, which is the last number mentioned
      if (!new RegExp(`\\b${model}\\b`).test(s)) continue;
      const nums = s.match(/\b\d{4}\b/g) || [];
      if (nums.length > 1 && nums[nums.length - 1] !== model) continue;
      const code = live.get(K(want));
      if (code) out.add(code);
    }
  }
  return [...out];
}
