// A purchase order made from a sales order names itself on the sales lines it
// buys, the way the office's plug-in leaves them (UDF_PONo / UDF_PODocKey /
// UDF_Creditor). The host is compiled and swapped on the office PC separately,
// so what the ERP can hold it to here is the text of the methods.
import { describe, expect, test } from 'vitest';
import rawAcSync from '../../scripts/autocount-service/AcSyncService.cs?raw';

const acSync = rawAcSync.replace(/\r\n/g, '\n');

function slice(from: string, to: string): string {
  const a = acSync.indexOf(from);
  expect(a, `AcSyncService.cs anchor missing: ${from}`).toBeGreaterThanOrEqual(0);
  const b = acSync.indexOf(to, a + from.length);
  expect(b, `AcSyncService.cs anchor missing after ${from}: ${to}`).toBeGreaterThan(a);
  return acSync.slice(a, b);
}

const link = () => slice('static void PointSalesLinesAtPurchase(', 'static List<Dictionary<string, object>> CreatedLines(');
const soToPo = () => slice('static string SoToPo(', 'static void SalesHeader(');
const edit = () => slice('Edit(Dictionary<string, object> p)', '// ── helpers');

describe('the sales line points back at the purchase order made from it', () => {
  test('/so-to-po points the sales lines at the purchase order once its costs are saved', () => {
    const body = soToPo();
    const saved = body.indexOf('po2.Save()');
    const linked = body.indexOf('PointSalesLinesAtPurchase(s, docNo);');
    expect(saved).toBeGreaterThan(0);
    expect(linked).toBeGreaterThan(saved);
    expect(linked).toBeLessThan(body.indexOf('return docNo;', saved));
  });

  test('/edit does the same for a purchase order after its save, and for no other document type', () => {
    const body = edit();
    const saved = body.indexOf('doc.Save();');
    const call = body.indexOf('if (type == "PO") PointSalesLinesAtPurchase(s, docNo);');
    expect(saved).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(saved);
    expect(body.match(/PointSalesLinesAtPurchase\(/g)).toHaveLength(1);
  });

  test('the three fields go through SetUdf, which logs a refusal by name instead of swallowing it', () => {
    const body = link();
    for (const field of ['PONo', 'PODocKey', 'Creditor']) {
      expect(body).toMatch(new RegExp(`SetUdf\\("${field}"`));
    }
    expect(body).not.toMatch(/Set\(\(\) => d\.UDF/);
  });

  test('only a blank is filled: a line that names another purchase order keeps it', () => {
    const body = link();
    expect(body).toContain("ISNULL(d.UDF_PONo, '') = ''");
    expect(body).toContain('d.UDF_PONo = h.DocNo AND');
    expect(body).not.toMatch(/UDF_PONo\s*<>\s*h\.DocNo/);
  });

  test('it cannot cost the purchase order: the step is wrapped whole, and what landed is read back', () => {
    const body = link();
    expect(body).toMatch(/^static void PointSalesLinesAtPurchase\([^)]*\) \{\s*if \(string\.IsNullOrEmpty\(poDocNo\)\) return;\s*try \{/);
    expect(body).toContain('now name it');
  });
});
