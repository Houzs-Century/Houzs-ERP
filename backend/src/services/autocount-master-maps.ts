// GENERATED FILE — do not edit by hand.
// Source: backend/scripts/data/autocount-so-writeback-mappings.json
// Regenerate: node scripts/gen-autocount-master-maps.mjs
// CI guard:   npm run audit:ac-master-maps
//
// The four master-data spelling maps the write-back composes with. They are
// generated so that CONFIRMING A BINDING is an edit to the JSON — the file that
// also carries the reason, the harvest date and the book's own vocabularies —
// and never an edit to TypeScript. What each map means, and why BRANDING_MAP is
// an allow-list while the other three are not, is documented at the point of
// USE in autocount-writeback.ts, which re-exports all four.
//
// Keys are normalised to what `bookSpelling` looks up: uppercase, single-spaced.
/** ERP salesperson label -> AutoCount Sales Agent (the agent name IS the code). */
export const AGENT_MAP: Record<string, string> = {
  "ANTHONY": "ANTHONY",
  "YUNY": "YUNY",
  "KRIS": "KRIS",
  "SHAWN": "SHAWN",
  "LAWRENCE": "LAWRENCE",
  "KINGSLEY": "KINGSLEY",
  "STANLEY": "STANLEY",
  "JUNIE": "JUNIE",
  "MEI TING": "MEI TING",
  "PETER": "PETER",
  "WEI HOW": "WEI HOW",
  "RACHAEL": "RACHAEL",
  "SALLY": "SALLY",
  "ZACK": "Zack",
  "SHELDON TAN": "SHELDON",
  "JAMES SEOW": "JAMES SEOW",
  "LUCAS": "LUCAS",
  "ADRIAN": "ADRIAN",
  "ESTHER CHONG": "ESTHER CHONG",
  "MELVIN CHONG": "MELVIN CHONG",
  "CHEA HUAN": "Chea Huan",
  "WENGGI": "WENGGI",
  "KAR JIUN": "TAN KAR JIUN",
  "HWA SHENG": "Hwasheng",
  "SHI TING": "Chang Shi Ting",
  "LUIS TEO": "LUIS",
  "PEI FEN": "PEIFEN",
  "LIM YAU WEI": "LIM YAU WEI",
  "ETHAN": "ETHAN SOO",
  "WEI PIN": "WEIPIN",
};

/** ERP sales_location / warehouse code -> AutoCount location code. */
export const LOCATION_MAP: Record<string, string> = {
  "KL WAREHOUSE": "KL",
  "PG WAREHOUSE": "PG",
  "SLGR WAREHOUSE": "KL",
  "KUALA LUMPUR": "KL",
  "PETALING JAYA": "KL",
  "CHERAS": "KL",
  "SHAH ALAM": "KL",
  "GEORGE TOWN": "PG",
  "KOTA KINABALU": "SBH",
  "KUANTAN": "KL",
  "JOHOR BAHRU": "KL",
  "KL": "KL",
  "PG": "PG",
  "SRW": "SRW",
  "SBH": "SBH",
  "HQ": "HQ",
};

/** ERP venue -> AutoCount VENUE UDF option (the book appends SOLO, JOHOR, ...). */
export const VENUE_MAP: Record<string, string> = {
  "SUNWAY PYRAMID CONVENTION CENTRE": "SUNWAY PYRAMID CONVENTION CENTRE",
  "SUTERA MALL": "SUTERA MALL SOLO",
  "KLCC CONVENTION CENTRE": "KUALA LUMPUR CONVENTION CENTRE",
  "SUTERA SQUARE": "SUTRA SQUARE JOHOR",
  "MVEC SOUTHKEY": "MIDVALLEY SOUTHKEY JB",
  "SUNWAY KLUANG MALL": "SUNWAY KLUANG MALL SOLO",
  "KSL CITY MALL": "KSL CITY MALL JOHOR SOLO",
};

/** ERP branding -> AutoCount BRANDING UDF option. ALLOW-LIST — see branding_note. */
export const BRANDING_MAP: Record<string, string> = {
  "AKEMI": "AKEMI",
  "DUNLOPILLO": "DUNLOPILLO",
  "ERGOTEX": "ERGOTEX",
  "MYLATEX": "MYLATEX",
  "HOUZS": "HOUZS",
  "ZANOTTI": "ZANOTTI",
  "NONE": "NONE",
  "CARRESS": "CARRESS",
  "DUNLOP": "DUNLOP",
};
