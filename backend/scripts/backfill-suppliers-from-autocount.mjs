// Backfill the HOUZS supplier master from the AutoCount creditor export
// "Houzs - Supplier List (Stock Only).xlsx" (2026-08-06, 38 rows, embedded
// below as DATA so this script needs no file at runtime).
//
// DRY-RUN unless APPLY=1. Idempotent. Every write runs in ONE transaction.
//
//   node scripts/backfill-suppliers-from-autocount.mjs            # dry run
//   APPLY=1 node scripts/backfill-suppliers-from-autocount.mjs    # write
//
// WHAT IT DOES, AND THE RULES IT WAS APPROVED UNDER (Chew, 2026-08-06):
//
//   1. FILL-EMPTY-ONLY. For the suppliers that exist in scm.suppliers under
//      the HOUZS company, copy a field from the AutoCount row ONLY when the
//      live column is NULL/blank: registration_no, address1-4, postcode,
//      attention, mobile, phone, phone2, website, notes (from "2nd
//      Description"), supplier_type (from "Creditor Type"). A column that
//      already holds a value is never overwritten — when the two sides
//      disagree the difference is FLAGGED in the output and left alone.
//      Names are deliberately not touched (400-B002 / 400-N001 hold short
//      names on purpose — "不改，保持系统现状").
//
//   2. APPROVED OVERWRITES (the only places a non-empty value changes):
//      a. Two China suppliers' phones carry the wrong country code in
//         production (+60 on numbers that are mainland mobiles — the
//         country-code backfill assumed Malaysia). 400-C005 and 400-J002
//         are corrected to +86.
//      b. Registration-number FORMAT UPGRADE (approved 2026-08-06 after the
//         first dry run): where the live column holds the short old-format
//         number and the AutoCount value is the full "newformat (oldformat)"
//         string CONTAINING it, the full form replaces the short form. Same
//         number, richer format — a full value that does NOT contain the
//         live one is still only flagged, never written.
//
//      Also from that dry-run review: an AutoCount "Website" value that is
//      actually an EMAIL ADDRESS (contains @ — 400-N002, 400-T002) is
//      redirected to the email column instead of being copied into website
//      verbatim, fill-empty-only as usual.
//
//   3. ONE INSERT: 400-S007 SWEET HOME INTERNATIONAL SDN BHD is in the
//      AutoCount list but not in the system — approved as a new row.
//
//   4. SKIP LIST: 400-N003 and 405-N001 (Nantong Yourui old/new pair) are
//      not touched at all — owner of the data asked to leave them for later.
//
// COMPANY SCOPING IS NOT OPTIONAL. scm.suppliers is per-company with
// UNIQUE (company_id, code) (mig 0083 + 0087); every read and write here is
// pinned to the HOUZS company id resolved at runtime. Without that, a 2990
// supplier sharing a code would be silently corrupted.
//
// Phone values are normalized to the repo's E.164 storage convention
// (scm/shared/phone.ts): "+<digits>", explicit "+" country codes preserved,
// bare Malaysian numbers get +60 — EXCEPT bare numbers on a CNY supplier,
// which get +86 (a bare 13x number on a China supplier is a mainland mobile;
// prefixing +60 is exactly the bug rule 2 corrects). "A/B"-style dual-line
// strings keep the first alternative before normalizing (400-A003).
//
// Exit 0 for every legitimate outcome including "nothing to do". Non-zero
// only for an unreachable database or a real query error.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const APPLY = process.env.APPLY === "1";

const SKIP = new Set(["400-N003", "405-N001"]);
const INSERT_CODES = new Set(["400-S007"]);
// The single approved non-empty overwrite: production has +60 on mainland
// China mobiles. Values are the AutoCount numbers with the correct dial code.
const PHONE_FIX = {
  "400-C005": "+8613262989777",
  "400-J002": "+8615817803288",
};

// AutoCount creditor export, extracted verbatim (nulls preserved).
const DATA = [
  {"code":"400-A001","name":"AEROFOAM BEDDING (1969) SDN BHD","desc2":null,"registrationNo":"91919-T","creditorType":"SUPPLIER","address1":"NO.4, PERSIARAN SULTAN ALAUDDIN/KU17,","address2":"BANDAR SULTAN SULEIMAN,","address3":"42000 PORT KLANG, SELANGOR DARUL EHSAN.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+603-31767866","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-A003","name":"ANNEX DESIGN SDN BHD","desc2":null,"registrationNo":"200201011451 (579114-V）","creditorType":"SUPPLIER","address1":"AL190, LOT 2357, BLOCK J,","address2":"KG BARU SUNGAI BULOH","address3":"47000 SELANGOR DARUL EHSAN,","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+603-6156/6157 9999","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-A004","name":"ARMANI SOFA SDN. BHD.","desc2":null,"registrationNo":"202101037290 (1437590-H)","creditorType":"SUPPLIER","address1":"NO.4, JALAN P4/8A,","address2":"BANDAR TEKNOLOGI KAJANG,","address3":"43500 SEMENYIH, SELANGOR.","address4":null,"postcode":"43500","attention":null,"mobile":null,"phone1":"+6018-907 2608","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-B002","name":"BEST COMFORT BEDDING SDN BHD","desc2":null,"registrationNo":"201701006116 (1220281-M)","creditorType":"SUPPLIER","address1":"No. 5, Jalan Kajang Jaya 2,","address2":"Kawasan Perindustrian Kajang Jaya,","address3":"43500 Semenyih, Selangor","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+6012-777 9972","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-B003","name":"BEST KIM KANG SDN BHD","desc2":null,"registrationNo":"201001023535 (907306-K)","creditorType":"SUPPLIER","address1":"7380, JALAN BAGAN AJAM,","address2":"TAMAN INTAN,","address3":"13000, BUTTERWORTH.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+604-323 3689","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-B004","name":"BEDDING COMMERCE SDN. BHD.","desc2":null,"registrationNo":"202401039645 (1585492-A)","creditorType":"SUPPLIER","address1":"LOT 60, BATU 11,","address2":"JALAN CHERAS,","address3":"43000 KAJANG, SELANGOR.","address4":null,"postcode":null,"attention":"DEALER SALES - CHEH LI","mobile":null,"phone1":"+603-8736 7685","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-C002","name":"CARRES SDN. BHD.","desc2":null,"registrationNo":"202401055306 (1601150-X)","creditorType":"SUPPLIER","address1":"E-28-02 & E-28-03, MENARA SUEZCAP 2,","address2":"KL GATEWAY, NO. 2, JALAN KERINCHI,","address3":"GERBANG KERINCHI LESTARI,","address4":"59200 W.P. KUALA LUMPUR.","postcode":null,"attention":null,"mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-C005","name":"CHUANG YI SE ZHI NENG KE JI (JIANG SU) SDN BHD","desc2":"创艺色智能科技 （江苏）有限公司","registrationNo":null,"creditorType":"SUPPLIER","address1":"89687转翼捷，13170015054-2175,","address2":"广东省 广州市 白云区 均禾街道","address3":"瞎话二路 广东省农机仓库89687","address4":"石马仓库12仓89687","postcode":null,"attention":null,"mobile":null,"phone1":"13262989777","phone2":null,"website":null,"currency":"CNY","active":"Checked"},
  {"code":"400-D001","name":"DUNLOPILLO (M) SDN BHD","desc2":null,"registrationNo":"199501000668 (329862-P)","creditorType":"SUPPLIER","address1":"A-6-3A, EMPIRE TOWER,","address2":"EMPIRE SUBANG,JALAN SS16/1,","address3":"47500 SUBANG JAYA, SELANGOR","address4":null,"postcode":"47500","attention":null,"mobile":null,"phone1":"+603 5628 7000","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-D002","name":"DIGLANT MANUFACTURING SDN BHD.","desc2":null,"registrationNo":"202201014175 (1459872-U)","creditorType":"SUPPLIER","address1":"LOT 2395 & LOT 2397,","address2":"JALAN SUNGAI SEMBILANG,","address3":"SIMPANG EMPAT, JALAN KERETAPI LAMA,","address4":"KUALA SELANGOR, SELANGOR, MALAYSIA.","postcode":"45800","attention":null,"mobile":null,"phone1":"+603-31766309","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-D004","name":"DORSETTLOFT SOFA SDN. BHD.","desc2":null,"registrationNo":"202501016743 (1618157-X)","creditorType":"SUPPLIER","address1":"NO. 4, JALAN P4/8A,","address2":"BANDAR TEKONOLOGI KAJA,","address3":"43500 SEMENYIH, SELANGOR","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+6018-960 2608","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-E001","name":"EASTERN DECORATOR SDN BHD","desc2":null,"registrationNo":"197401000210 (17263-D)","creditorType":"SUPPLIER","address1":"Suite E-3A-2, Level 3A, Corporate","address2":"Building (Block E), Southgate Commercial","address3":"Centre, No.2, Jalan Dua, Off Jalan Chan","address4":"Sow Lin, 55200 Kuala Lumpur","postcode":null,"attention":null,"mobile":null,"phone1":"+60392223488","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-E004","name":"EADECO SDN. BHD.","desc2":null,"registrationNo":"198901008376 (185678-A)","creditorType":"SUPPLIER","address1":"LOT 2395 & 2397, JALAN SUNGAI SEMBILANG,","address2":"SIMPANG EMPAT, JALAN KERETAPI LAMA,","address3":"45800 JERAM,","address4":"KUALA SELANGOR, SELANGOR.","postcode":null,"attention":null,"mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-E005","name":"ELEGANT TOTAL HOME SDN BHD","desc2":null,"registrationNo":"199301013799 (268537-K)","creditorType":"SUPPLIER","address1":"LOT NO. PT-16690,","address2":"JALAN PERMATA 2,","address3":"ARAB-MALAYSIAN INDUSTRIAL PARK,","address4":"71800 NILAI, NEGERI SEMBILAN","postcode":null,"attention":null,"mobile":null,"phone1":"+606-7990788","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-G002","name":"GOODNITE INTERNATIONAL SDN BHD","desc2":null,"registrationNo":"201701042292 (1256465-V)","creditorType":"SUPPLIER","address1":"WISMA GOODNITE, LOT 1249,","address2":"BATU 15, JALAN KAPAR,","address3":"KLANG, SELANGOR DARUL EHSAN.MALAYSIA.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+603-32503333","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-G003","name":"GETHA BEDDING (M) SDN BHD","desc2":null,"registrationNo":"199201017049 (248553-A)","creditorType":"SUPPLIER","address1":"LOT 60, BATU 11,","address2":"JALAN CHERAS,","address3":"43000 KAJANG, SELANGOR.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+603-87367685","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-G005","name":"GUANGDONG DIGLANT FURNITURE INDUSTRIAL CO.LTD","desc2":null,"registrationNo":null,"creditorType":"SUPPLIER","address1":null,"address2":null,"address3":null,"address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"CNY","active":"Checked"},
  {"code":"400-H002","name":"HIN LIM FURNITURE MANUFACTURER SDN. BHD.","desc2":null,"registrationNo":"199301021581 (276319-A)","creditorType":"SUPPLIER","address1":"NO 8, LORONG BAKAU 1,","address2":"FURNITURE VILLAGE OF SUNGAI BAONG","address3":"SUNGAI BAKAP,","address4":"SEBERANG PERAI SELATAN, PULAU PINANG","postcode":"14200","attention":"MS CH KHOO","mobile":null,"phone1":"017-2448535","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-H003","name":"HOOKKA MANUFACTURING SDN. BHD.","desc2":null,"registrationNo":"202501018549 (1619963-D)","creditorType":"SUPPLIER","address1":"2775F JALAN INDUSTRI 12,","address2":"KAMPUNG BARU SUNGAI BULOH,","address3":"47000 SUNGAI BULOH.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-J002","name":"JIUWUYISAN FURNITURE (9513家具)","desc2":null,"registrationNo":null,"creditorType":"SUPPLIER","address1":"广东省佛山市南海区九江镇","address2":"沙头夏江工业园B区兴业一路15号","address3":null,"address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"15817803288","phone2":null,"website":null,"currency":"CNY","active":"Checked"},
  {"code":"400-J003","name":"JIAXING LEE'S TEXTILE CO LTD","desc2":null,"registrationNo":null,"creditorType":"SUPPLIER","address1":"NO.68 YANYE ROAD,","address2":"FENGMING STREET,","address3":"TONGXIANG CITY, ZHEJIANG CHINA","address4":null,"postcode":null,"attention":"Zhang Li Feng","mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"CNY","active":"Checked"},
  {"code":"400-L002","name":"LAVEO LIVING SDN BHD","desc2":null,"registrationNo":"202101019728 (1420028-H)","creditorType":"SUPPLIER","address1":"Lot 2287, (AL 135), Kg. Baru Sg. Buloh,","address2":"47000 Sg. Buloh, Selangor, Malaysia.","address3":null,"address4":null,"postcode":"47000","attention":null,"mobile":null,"phone1":"+603-6148 9337","phone2":null,"website":"www.laveo.com.my","currency":"MYR","active":"Checked"},
  {"code":"400-M002","name":"M&N FURNITURE TRADING SDN. BHD","desc2":null,"registrationNo":"200501023904 (706036-K)","creditorType":"SUPPLIER","address1":"LOT 5317,","address2":"KAJANG INDUSTRIAL JAYA,","address3":"43500 SEMENYIH, SELANGOR.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+603-8724 3828","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-N001","name":"NAKI TRADING (M) SDN BHD","desc2":null,"registrationNo":"202101021331 (1421631-P)","creditorType":"SUPPLIER","address1":"NO. JAL 56/19-4/5 STORE,","address2":"JALAN KAMPUNG MINYAK BEKU,","address3":"83000 BATU PAHAT, JOHOR.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+6016-9637571","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-N002","name":"NB FURNITURE (M) SDN BHD","desc2":null,"registrationNo":"201901035338 (1344668-W)","creditorType":"SUPPLIER","address1":"PLO 453, JALAN WAWASAN 14,","address2":"KAWASAN PERINDUSTRIAN SRI GADING FASA 2,","address3":"MUKIM SIMPANG KANAN,","address4":"83300 BATU PAHAT, JOHOR","postcode":null,"attention":null,"mobile":null,"phone1":"+607-455 9340","phone2":null,"website":"sales@nbfurniture.com.my","currency":"MYR","active":"Checked"},
  {"code":"400-N003","name":"NAN TONG YOU RUI FANG ZHI PIN SDN BHD","desc2":"(南通佑瑞纺织品有限公司)","registrationNo":null,"creditorType":"SUPPLIER","address1":"808","address2":null,"address3":null,"address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"15733777221","phone2":null,"website":null,"currency":"MYR","active":"Unchecked"},
  {"code":"400-N004","name":"NICE FUTURE MARKETING SDN. BHD.","desc2":null,"registrationNo":"202301031429 (1525352-K)","creditorType":"SUPPLIER","address1":"NO.5, WELLOYD INDUSTRIA PARK,","address2":"LORONG HAJI ABDUL MANAN / KU 8,","address3":"MERU, 41050 KLANG, SELANGOR.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+603-3396 5977","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-O002","name":"OHANA STUDIO MARKETING SDN. BHD.","desc2":null,"registrationNo":"202501058806 (1660212-M)","creditorType":"SUPPLIER","address1":"THE NEST RESIDENCES, A-28-07","address2":"JALAN A OFF, JALAN PUCHONG","address3":"58200 KUALA LUMPUR,","address4":"W.P. KUALA LUMPUR.","postcode":null,"attention":null,"mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-R001","name":"RED SOFA PLT","desc2":null,"registrationNo":"LLP0003322-LGN","creditorType":"SUPPLIER","address1":"NO 63, JALAN KP4","address2":"KAWASAN PREINDUSTRIAN KOTA PUTERI","address3":"48100,BATU ARANG SELANOR","address4":null,"postcode":"48100","attention":"ALEX LEE","mobile":null,"phone1":"+6018-238 1168","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-S002","name":"VARIASI IMPIAN SDN BHD","desc2":null,"registrationNo":"200601025405 (745159-U)","creditorType":"SUPPLIER","address1":"LOT 939&940, JALAN INDUSTRY 10,","address2":"SUNGAI BULOH NEW VILLAGE","address3":"47000 SUNGAI BULOH","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+6016-385 3988","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-S004","name":"GLOPADU (M) SDN BHD","desc2":null,"registrationNo":"200401004538 (643041-D)","creditorType":"SUPPLIER","address1":"NO.342-1A, JALAN 3D,","address2":"KAMPUNG BARU SUBANG","address3":"40100 SHAH ALAM, SELANGOR.","address4":null,"postcode":"40100","attention":null,"mobile":null,"phone1":"+603-7832 0650","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-S005","name":"SD DREAM WORLD SDN BHD","desc2":null,"registrationNo":"200801022635 (823954-W)","creditorType":"SUPPLIER","address1":"LOT 977, BATU 12 1/2,  JALAN CHERAS","address2":"KG BUKIT DUKUNG, 43200 CHERAS,","address3":"SELANGOR.","address4":null,"postcode":"43200","attention":null,"mobile":null,"phone1":"+603-8737 0258","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-S006","name":"SWIFT FURNITURE SDN. BHD.","desc2":null,"registrationNo":"202401041025 (1586871-P)","creditorType":"SUPPLIER","address1":"AL53E (LOT 2389), JALAN INDUSTRI 5,","address2":"KAMPUNG BARU SUNGAI BULOH,","address3":"47000 SUNGAI BULOH, SELANGOR.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":null,"phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-S007","name":"SWEET HOME INTERNATIONAL SDN BHD","desc2":null,"registrationNo":"202201002105 (1447802-W)","creditorType":"SUPPLIER","address1":"1364, MAINROAD,","address2":"JALAN BESAR, TAMAN MAS,","address3":"14100 SIMPANG AMPAT,","address4":"PULAU PINANG, MALAYSIA","postcode":null,"attention":null,"mobile":null,"phone1":"+6011-1123 5125","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"400-T002","name":"T.H.L. SOFA SDN BHD","desc2":null,"registrationNo":"199401013363 (299043-W)","creditorType":"SUPPLIER","address1":"NO. 25, PT145360 OFF JALAN SERAMIK CHEPOR 11/1,","address2":"PUSAT SERAMIK FASA 2,","address3":"31200 CHEPOR, PERAK","address4":null,"postcode":"31200","attention":null,"mobile":null,"phone1":"+605-201 3576","phone2":null,"website":"belinda.heng@tghlsofa.com","currency":"MYR","active":"Checked"},
  {"code":"400-T005","name":"TODERN HOME SDN BHD","desc2":null,"registrationNo":"202001040961 (1397282-P)","creditorType":"SUPPLIER","address1":"NO 6, JALAN KAJANG JAYA 2,","address2":"KAWASAN PERINDUSTRIAN KAJANG JAYA,","address3":"SEMENYIH, 43500 SELANGOR.","address4":null,"postcode":null,"attention":null,"mobile":null,"phone1":"+6018-667 9068","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"405-M004","name":"MAJESTIC CREATION SDN BHD","desc2":null,"registrationNo":"201801006204 (1268218-H)","creditorType":"SUPPLIER","address1":"NO. 34, JALAN PBS 14/4,","address2":"TAMAN PERINDUSTRIAN BUKIT SERDANG,","address3":"43300 SERI KEMBANGAN, SELANGOR","address4":null,"postcode":null,"attention":null,"mobile":"603-8945 4822","phone1":"+6012-613 2759","phone2":null,"website":null,"currency":"MYR","active":"Checked"},
  {"code":"405-N001","name":"NANTONG YOURUI TEXTILE CO., LTD.","desc2":null,"registrationNo":null,"creditorType":"SUPPLIER","address1":"GROUP 15, YUZHU VILLAGE, CHANGLE TOWN,","address2":"HAIMEN DISTRICT, NANTONG CITY,","address3":"JIANGSU PROVINCE","address4":null,"postcode":null,"attention":"WANG KAI","mobile":null,"phone1":"13362748640","phone2":null,"website":null,"currency":"CNY","active":"Checked"},
];

// Fill-empty-only field map: [DATA key, scm.suppliers column].
const FIELD_MAP = [
  ["registrationNo", "registration_no"],
  ["address1", "address1"],
  ["address2", "address2"],
  ["address3", "address3"],
  ["address4", "address4"],
  ["postcode", "postcode"],
  ["attention", "attention"],
  ["mobileNorm", "mobile"],
  ["phone1Norm", "phone"],
  ["phone2Norm", "phone2"],
  ["website", "website"],
  ["emailFromWebsite", "email"],
  ["desc2", "notes"],
  ["creditorType", "supplier_type"],
];

// Registration-number format upgrade (approved overwrite 2b): the full
// AutoCount value may replace a non-empty short-form ONLY when it contains
// that short form. Compared with whitespace collapsed, since AutoCount pads
// unevenly ("201701006116 (1220281-M) ").
function regUpgradeAllowed(liveVal, incoming) {
  const live = String(liveVal).replace(/\s+/g, " ").trim();
  const full = String(incoming).replace(/\s+/g, " ").trim();
  return live !== "" && full !== live && full.includes(live);
}

// Port of scm/shared/phone.ts normalizePhone, plus the two rules that file
// cannot know: dual-line "6156/6157 9999" keeps the first alternative, and a
// bare number on a CNY supplier is a mainland mobile (+86, never +60).
function normPhone(raw, currency) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/(\d+)\/\d+/, "$1");
  const hadPlus = s.startsWith("+");
  const digits = s.replace(/\D+/g, "");
  if (digits.length === 0) return null;
  if (hadPlus) return "+" + digits;
  if (currency === "CNY") return "+86" + digits;
  if (digits.startsWith("60")) return "+" + digits;
  if (digits.startsWith("0")) return "+60" + digits.slice(1);
  if (digits.length >= 8) return "+60" + digits;
  return null;
}

const isBlank = (v) => v == null || String(v).trim() === "";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const [houzs] = await pg`SELECT id FROM public.companies WHERE code = 'HOUZS'`;
  if (!houzs) {
    console.error("companies has no HOUZS row — refusing to guess a company_id.");
    process.exit(1);
  }
  const companyId = houzs.id;

  // Pre-compute normalized phones once so the plan and the write agree.
  // A "Website" that is actually an email address (source-file quirk) is
  // redirected to the email column rather than copied into website verbatim.
  for (const d of DATA) {
    d.mobileNorm = normPhone(d.mobile, d.currency);
    d.phone1Norm = normPhone(d.phone1, d.currency);
    d.phone2Norm = normPhone(d.phone2, d.currency);
    d.emailFromWebsite = null;
    if (d.website && d.website.includes("@")) {
      d.emailFromWebsite = d.website;
      d.website = null;
    }
  }

  const codes = DATA.map((d) => d.code);
  const live = await pg`
    SELECT code, name, registration_no, address1, address2, address3, address4,
           postcode, attention, mobile, phone, phone2, website, notes,
           supplier_type, currency
      FROM scm.suppliers
     WHERE company_id = ${companyId} AND code IN ${pg(codes)}`;
  const liveByCode = new Map(live.map((r) => [r.code, r]));

  const plan = []; // { code, sets: {col: val}, isInsert }
  const flags = [];
  let skipped = 0;

  for (const d of DATA) {
    if (SKIP.has(d.code)) {
      skipped++;
      continue;
    }
    const row = liveByCode.get(d.code);

    if (!row) {
      if (INSERT_CODES.has(d.code)) {
        plan.push({ code: d.code, isInsert: true, d });
      } else {
        flags.push(`${d.code} 不在系统里（也不在批准的新增名单里）— 跳过`);
      }
      continue;
    }

    const sets = {}; // col -> value (fill-empty; write path re-guards)
    const overwrites = new Set(); // cols allowed to replace a non-empty value
    for (const [key, col] of FIELD_MAP) {
      const incoming = d[key];
      if (incoming == null) continue;
      if (isBlank(row[col])) {
        sets[col] = incoming;
      } else if (String(row[col]).trim() !== String(incoming).trim()) {
        // Occupied and different. Two approved overwrites pass through
        // (phone fix handled below; registration format upgrade here);
        // everything else is flagged and left alone.
        if (col === "phone" && PHONE_FIX[d.code]) continue;
        if (col === "registration_no" && regUpgradeAllowed(row[col], incoming)) {
          sets[col] = incoming;
          overwrites.add(col);
          continue;
        }
        flags.push(`${d.code} ${col} 不一致 — 系统: "${row[col]}" / 文件: "${incoming}" (未改)`);
      }
    }

    if (PHONE_FIX[d.code] && String(row.phone ?? "").trim() !== PHONE_FIX[d.code]) {
      sets.phone = PHONE_FIX[d.code];
      overwrites.add("phone");
    }

    if (d.currency && row.currency && d.currency !== row.currency) {
      flags.push(`${d.code} currency 不一致 — 系统: ${row.currency} / 文件: ${d.currency} (未改，改币种影响采购单据，需单独决定)`);
    }

    if (Object.keys(sets).length > 0) plan.push({ code: d.code, sets, overwrites, row });
  }

  // ── Report the plan ──
  const updates = plan.filter((p) => !p.isInsert);
  const inserts = plan.filter((p) => p.isInsert);

  console.log(`\n== 补录计划 (company_id=${companyId} HOUZS) ==`);
  for (const p of updates) {
    console.log(`  ${p.code}  ${p.row.name}`);
    for (const [c, v] of Object.entries(p.sets)) {
      const mark = p.overwrites.has(c) ? "  [覆盖-已批准]" : "";
      console.log(`      ${c} ← "${v}"${mark}`);
    }
  }
  for (const p of inserts) {
    console.log(`  ${p.code}  ${p.d.name}  [新增]`);
  }
  if (flags.length) {
    console.log(`\n== 标记（不会改，仅供裁决）==`);
    for (const f of flags) console.log(`  ${f}`);
  }

  notice(`plan: ${updates.length} 家补资料, ${inserts.length} 家新增, ${skipped} 家跳过(Nantong), ${flags.length} 条标记`);

  if (!APPLY) {
    notice("DRY RUN — 没有写入任何东西。确认清单后用 APPLY=1 重跑。");
  } else if (plan.length === 0) {
    notice("没有需要写入的东西 — 数据库已是最新。");
  } else {
    await pg.begin(async (tx) => {
      for (const p of updates) {
        // Guard every SET with its own emptiness check inside the
        // transaction, so a concurrent edit between the read above and this
        // write can never be overwritten. The approved overwrites (phone
        // fix, registration format upgrade) are the exception.
        for (const [col, val] of Object.entries(p.sets)) {
          if (p.overwrites.has(col)) {
            await tx`
              UPDATE scm.suppliers SET ${tx({ [col]: val })}, updated_at = now()
               WHERE company_id = ${companyId} AND code = ${p.code}`;
          } else {
            await tx`
              UPDATE scm.suppliers SET ${tx({ [col]: val })}, updated_at = now()
               WHERE company_id = ${companyId} AND code = ${p.code}
                 AND (${tx(col)} IS NULL OR btrim(${tx(col)}::text) = '')`;
          }
        }
      }
      for (const p of inserts) {
        const d = p.d;
        await tx`
          INSERT INTO scm.suppliers ${tx({
            company_id: companyId,
            code: d.code,
            name: d.name,
            registration_no: d.registrationNo,
            supplier_type: d.creditorType,
            address1: d.address1,
            address2: d.address2,
            address3: d.address3,
            address4: d.address4,
            postcode: d.postcode,
            attention: d.attention,
            mobile: d.mobileNorm,
            phone: d.phone1Norm,
            phone2: d.phone2Norm,
            website: d.website,
            notes: d.desc2,
            currency: d.currency ?? "MYR",
            status: "ACTIVE",
          })}
          ON CONFLICT (company_id, code) DO NOTHING`;
      }
    });
    notice(`APPLIED — ${updates.length} 家已补, ${inserts.length} 家已新增。`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
