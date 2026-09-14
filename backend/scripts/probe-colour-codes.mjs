// probe-colour-codes — READ-ONLY. Where do the colour codes named on the
// unresolved pillow lines live, if anywhere? Searches scm.fabric_colours and
// scm.fabric_trackings (company 1) by a loose pattern per code, and prints the
// colour-related fields of the ten sales-order lines. RE-RUN: idempotent.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }
const say = (m) => console.log(m);
const PATS = { "GD526-16": ["GD526", "526"], "CH151-5": ["CH151", "151"], "KN390-11": ["KN390", "390"], "MEKA-09": ["MEKA"], "M2401-1": ["M2401", "2401"],
  "M2402-9": ["M2402-9", "M2402-09"], "M2402-15": ["M2402-15"], "BO315-27": ["BO315-27"], "BO315-28": ["BO315-28"], "CH141-5": ["CH141-5", "CH141-05"], "CH141-1": ["CH141-1", "CH141-01"] };
for (const [code, pats] of Object.entries(PATS)) {
  say(`\n=== ${code} ===`);
  for (const p of pats) {
    const like = `%${p.replace(/-/g, "%")}%`;
    for (const r of await sql`SELECT fabric_id, colour_id, label, active, company_id FROM scm.fabric_colours WHERE colour_id ILIKE ${like} OR label ILIKE ${like} OR fabric_id ILIKE ${like} LIMIT 10`)
      say(`  colours  co${r.company_id} fabric=${r.fabric_id} colour=${r.colour_id} label=${r.label} active=${r.active}`);
    for (const r of await sql`SELECT fabric_code, fabric_description, supplier_code, is_active, company_id FROM scm.fabric_trackings WHERE fabric_code ILIKE ${like} OR supplier_code ILIKE ${like} OR fabric_description ILIKE ${like} LIMIT 10`)
      say(`  tracking co${r.company_id} code=${r.fabric_code} sup=${r.supplier_code} desc=${r.fabric_description} active=${r.is_active}`);
  }
}
say("\n=== the ten SO lines now ===");
for (const r of await sql`SELECT doc_no, line_no, item_code, variants->>'fabricCode' AS fc, variants->>'extraAddonNote' AS note, description2, left(remark, 60) AS remark
  FROM scm.mfg_sales_order_items WHERE company_id = 1 AND doc_no = ANY(${["HC-SO-2609-071","HC-SO-010214","HC-SO-012048","HC-SO-012686","HC-SO-012900","HC-SO-012046","HC-SO-012927","HC-SO-011561"]})
  AND upper(item_code) IN ('SQUARE PILLOW','LONG PILLOW','AR01','AR02','BC04','BC04-MF','BC05','BC05-MF','SB02') ORDER BY doc_no, line_no`)
  say(`  ${r.doc_no} ln${r.line_no} ${r.item_code} fabricCode=${r.fc ?? "-"} note="${r.note ?? ""}" d2="${(r.description2 ?? "").slice(0, 70)}" remark="${r.remark ?? ""}"`);
say("\nREAD-ONLY — nothing was written.");
await sql.end();
