// Restore sofa bindings wrongly deleted (they point to real LIVE AutoCount sofa
// codes; the earlier delete used a stale local DB copy). Supplier resolved by
// AutoCount prefix -> creditor code -> scm.suppliers.code. MODE=dry-run default.
import postgres from "postgres";
import fs from "fs";
const mode=(process.env.MODE||"apply").toLowerCase(); const apply=mode==="apply";
const cid=String(process.env.COMPANY_ID||"1");
const sql=postgres(process.env.DATABASE_URL,{ssl:"require",prepare:false,max:1});
const PREFIX2CRED={AMN:"400-A004",DSL:"400-D004",HOK:"400-O002",TD:"400-T005",TNS:"400-T004",THL:"400-T002",RDS:"400-R001",SVI:"400-S...",LV:"400-L..."};
const pairs=fs.readFileSync(new URL("./data/sofa-restore-pairs.tsv",import.meta.url),"utf8")
  .split(/\r?\n/).filter(Boolean).map(l=>{const[mat,sku]=l.split("\t");return{mat,sku};});
// supplier code -> id
const sup=await sql`SELECT code,id FROM scm.suppliers WHERE company_id=${cid}`;
const cred2id=Object.fromEntries(sup.map(s=>[s.code,s.id]));
let ins=0,skipBound=0,skipNoSup=0,skipNoProd=0,skipTD=0; const noSup=[],did=[];
for(const p of pairs){
  const prefix=(p.sku.split(/[-\s]/)[0]||"").toUpperCase();
  if(prefix==="TD"){ skipTD++; continue; } // live code is TD-SF####; ERP sku is wrong -> don't restore
  const cred=PREFIX2CRED[prefix]; const supId=cred?cred2id[cred]:null;
  const [prod]=await sql`SELECT name FROM scm.mfg_products WHERE company_id=${cid} AND code=${p.mat} LIMIT 1`;
  if(!prod){skipNoProd++;continue;}
  const [ex]=await sql`SELECT 1 FROM scm.supplier_material_bindings WHERE company_id=${cid} AND material_kind='mfg_product' AND material_code=${p.mat} AND supplier_sku IS NOT NULL AND btrim(supplier_sku)<>'' LIMIT 1`;
  if(ex){skipBound++;continue;}
  if(!supId){skipNoSup++;noSup.push(`${p.mat} -> ${p.sku} (prefix ${prefix}, cred ${cred||'?'})`);continue;}
  if(apply){ await sql`INSERT INTO scm.supplier_material_bindings (company_id,material_kind,material_code,material_name,supplier_id,supplier_sku,is_main_supplier) VALUES (${cid},'mfg_product',${p.mat},${prod.name},${supId},${p.sku},false)`; }
  ins++; did.push(`${p.mat} -> ${p.sku} [sup ${cred}]`);
}
console.log(`MODE=${mode}`);
console.log(`${apply?"RESTORED":"would restore"}: ${ins}`);
console.log(`skip TD (invalid code): ${skipTD}   skip already-bound: ${skipBound}   skip no-product: ${skipNoProd}   skip no-supplier: ${skipNoSup}`);
console.log("--- would restore ---"); did.forEach(x=>console.log("  "+x));
if(noSup.length){console.log("--- no supplier resolved ---"); noSup.forEach(x=>console.log("  "+x));}
await sql.end();
