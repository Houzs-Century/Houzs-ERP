#!/usr/bin/env node
/* Read-only: what is STILL not tidy in the fabric catalogue.

   The 2026-08-11 normalisation (normalize-fabric-codes.mjs) gave most rows the
   owner's shape — 系列 / code=SERIES-NN / 描述="CODE COLOUR". This probe finds
   the leftovers, grouped by WHY they are wrong, because each group needs a
   different fix and the owner should see the counts before anything is written.

   Why the shape matters (not cosmetics): fabric-tracking.ts colourLabelOf()
   takes everything AFTER THE FIRST SPACE of the description as the colour name.
   So "BABY WHITE" (no code prefix) displays as colour "WHITE", and
   "SF-AT-15 FABRIC" displays as colour "FABRIC". A wrong description is a wrong
   colour name in every picker.

   Writes nothing. */
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = Number(process.env.COMPANY || 1);

// same derivation the route uses, so this probe judges what the UI shows
const seriesOf = (code) => {
  const v = (code || "").trim().toUpperCase();
  const m = /^(.+)[\s-]+\d{1,3}$/.exec(v);
  const head = (m ? m[1] : v.split("-")[0]) || v;
  return head.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || v;
};
const colourLabelOf = (code, desc) => {
  const d = (desc ?? "").trim();
  const sp = d.indexOf(" ");
  return sp > 0 ? d.slice(sp + 1).trim() : code;
};

const NON_FABRIC = /^(SOFA|SQUARE\s*PILLOW|LONG\s*PILLOW|BOLSTER|STOOL|CONSOLE|MATTRESS|BEDFRAME|DIVAN|DELIVERY|TRANSPORT)/i;
const JUNK_TAIL = /\b(FABRIC|FABRICS|MATERIAL|COLOR|COLOUR|TBC|KIV|NEW|OLD)\b\s*$/i;

async function main() {
  const rows = await sql`SELECT id, fabric_code, description, supplier_code, sofa_tier, bedframe_tier
                         FROM scm.fabric_tracking WHERE company_id = ${CO} ORDER BY fabric_code`;
  note(`fabric_tracking rows (company ${CO}): ${rows.length}`);

  const g = { nonFabric: [], nameAsCode: [], junkTail: [], noPrefix: [], codeOnly: [], tidy: [] };
  for (const r of rows) {
    const code = (r.fabric_code || "").trim();
    const desc = (r.description || "").trim();
    const up = code.toUpperCase();
    const dup = desc.toUpperCase();

    if (NON_FABRIC.test(up)) { g.nonFabric.push(r); continue; }
    // legacy: the CODE itself carries the colour name (KS-01 BABY WHITE)
    if (/^[A-Z0-9-]+\s+[A-Z]/i.test(code) && /\s/.test(code)) { g.nameAsCode.push(r); continue; }
    if (JUNK_TAIL.test(desc)) { g.junkTail.push(r); continue; }
    if (!dup.startsWith(up)) { g.noPrefix.push(r); continue; }   // "BABY WHITE" for KS-01
    if (dup === up) { g.codeOnly.push(r); continue; }            // description is just the code
    g.tidy.push(r);
  }

  const show = (title, list, why, n = 12) => {
    note(`\n=== ${title}: ${list.length} ===`);
    note(`    ${why}`);
    for (const r of list.slice(0, n)) {
      note(`    ${String(r.fabric_code).padEnd(26)} | ${String(r.description ?? "").slice(0, 42).padEnd(42)} | 系列=${seriesOf(r.fabric_code)} 颜色名显示为="${colourLabelOf(r.fabric_code, r.description)}"`);
    }
    if (list.length > n) note(`    … 还有 ${list.length - n} 条`);
  };

  show("A 不是布料(产品混进来了)", g.nonFabric, "SOFA / PILLOW 这类产品码不该在布料表里 — 要确认是谁写进来的再决定停用还是删");
  show("B 名字被当成代码(旧格式)", g.nameAsCode, "code 栏里带了颜色名,没有 series — 8/11 规范化之前的老行");
  show("C 描述尾巴多余词", g.junkTail, "颜色名会被读成 FABRIC / TBC 这种词");
  show("D 描述没带代码前缀", g.noPrefix, "colourLabelOf 会吃掉第一个词 — 'BABY WHITE' 显示成 'WHITE'");
  show("E 描述只有代码、没有颜色名", g.codeOnly, "颜色名回退成整串代码 — 能用但不好认");
  note(`\n=== 已经整齐 ===: ${g.tidy.length}`);

  // possible cross-series duplicates: two series whose colour NAME sets overlap
  const bySeries = new Map();
  for (const r of g.tidy.concat(g.codeOnly)) {
    const s = seriesOf(r.fabric_code);
    if (!bySeries.has(s)) bySeries.set(s, new Set());
    bySeries.get(s).add(colourLabelOf(r.fabric_code, r.description).toUpperCase());
  }
  const names = [...bySeries.entries()].filter(([, set]) => set.size >= 3);
  const pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const [a, A] = names[i], [b, B] = names[j];
    const shared = [...A].filter((x) => B.has(x) && !/^[A-Z0-9-]+$/.test(x));
    if (shared.length >= 3) pairs.push({ a, b, shared: shared.length, eg: shared.slice(0, 3).join(", ") });
  }
  note(`\n=== F 可能是同一批布的两个系列(颜色名重叠 ≥3): ${pairs.length} ===`);
  note(`    只是线索,不是判定 — 合并必须 owner 点头(FG66151 / PC151 就是这种)`);
  for (const p of pairs.slice(0, 15)) note(`    ${p.a}  ↔  ${p.b}   共同颜色 ${p.shared} 个: ${p.eg}`);

  /* G. OVER-SPLIT SERIES — "J9883-1-01" parses to series J9883-1 while the real
     series J9883 already exists (owner 2026-08-12: "J9883-01 才对不是吗?").
     A stray numeric segment in the middle of the code splinters one series into
     two, so the colour lands in a series of its own. */
  const allSeries = new Set(rows.map((r) => seriesOf(r.fabric_code)));
  const over = [];
  for (const r of rows) {
    const s = seriesOf(r.fabric_code);
    const m = /^(.+)-(\d{1,2})$/.exec(s);          // series itself ends in -N
    if (m && allSeries.has(m[1])) {
      const tail = /(\d{1,3})$/.exec((r.fabric_code || "").trim());
      over.push({ code: r.fabric_code, series: s, parent: m[1],
                  should: tail ? `${m[1]}-${String(tail[1]).padStart(2, "0")}` : `${m[1]}-??` });
    }
  }
  note(`\n=== G 系列被切碎(代码中间多一段数字): ${over.length} ===`);
  note(`    真正的系列已经存在,这些行却各自成了一个系列 — 改代码要连带把引用它的单据行改过去`);
  for (const o of over.slice(0, 20)) note(`    ${String(o.code).padEnd(20)} 系列=${String(o.series).padEnd(14)} → 应该是 ${o.should}(系列 ${o.parent})`);

  await sql.end({ timeout: 5 });
}
main().catch(async (e) => { console.error("FAIL", e.message); await sql.end({ timeout: 5 }); process.exit(1); });
