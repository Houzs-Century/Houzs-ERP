import fs from 'node:fs';
import zlib from 'node:zlib';
import postgres from 'postgres';
const dsn=fs.readFileSync('C:/Users/User/Desktop/.db-align/connection.txt','utf8').trim().split(/\r?\n/).filter(Boolean).pop();
const sql=postgres(dsn,{ssl:'require',max:1,prepare:false});
await sql`SET default_transaction_read_only = on`;
const b=JSON.parse(zlib.gunzipSync(fs.readFileSync('scripts/data/supplier-so-detail-2026-09-11.json.gz')).toString('utf8'));
for(const ref of ['PO-2609-051','PO-009989','PO-010086','PO-010041']){
  const d=b.documents.find(x=>x.ourPoRef===ref);
  console.log('=== supplier',d.supplierDoc,d.supplierDate,'ref',ref,'cust',d.ourRef);
  for(const l of d.lines.filter(l=>l.group==='SOFA')) console.log('   SUP',l.code,'x',l.qty,'RM',l.unitPrice,JSON.stringify(l.desc2));
  const [po]=await sql`SELECT p.id,p.po_number,p.status::text st,s.name sup FROM scm.purchase_orders p LEFT JOIN scm.suppliers s ON s.id=p.supplier_id
     WHERE p.company_id=1 AND (p.linked_ac_docno=${ref} OR p.po_number=${ref} OR p.po_number=${'HC-'+ref})`;
  if(!po){console.log('   (no PO)');continue;}
  console.log('   OUR PO',po.po_number,po.st,po.sup);
  const items=await sql`SELECT id,item_code,qty,received_qty,unit_price_sen,so_item_id,variants FROM scm.purchase_order_items WHERE purchase_order_id=${po.id} AND upper(coalesce(item_group,''))='SOFA' ORDER BY id`;
  for(const i of items) console.log(`   OUR ${i.item_code} x${i.qty} recv=${i.received_qty} RM${(i.unit_price_sen/100).toFixed(2)} seat=${(i.variants||{}).seatHeight} fab=${(i.variants||{}).fabricCode}`);
  const soIds=items.map(i=>i.so_item_id).filter(Boolean);
  if(soIds.length){
    const so=await sql`SELECT doc_no,item_code,qty FROM scm.mfg_sales_order_items WHERE id=ANY(${soIds})`;
    console.log('   SO lines:', so.map(r=>`${r.doc_no} ${r.item_code}x${r.qty}`).join(' | '));
  }
}
await sql.end();
