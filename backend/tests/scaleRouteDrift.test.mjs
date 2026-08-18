import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from 'vitest';
import ts from "typescript";
import { SO_LIST_COLUMNS } from "../scripts/scale-pg-real-schema.mjs";

const readRoute = (path) => readFile(new URL(path, import.meta.url), "utf8");

const stringExpressionValue = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return stringExpressionValue(node.left) + stringExpressionValue(node.right);
  }
  throw new Error(`Unsupported HEADER expression node: ${ts.SyntaxKind[node.kind]}`);
};

const productionSoListColumns = (source) => {
  const file = ts.createSourceFile("mfg-sales-orders.ts", source, ts.ScriptTarget.Latest, true);
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "HEADER") {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(initializer, "production HEADER declaration was not found");
  /* The suffix LIST_COLS appends to HEADER, hand-copied — so a change to it
     shows up here as a red test rather than as a benchmark quietly measuring a
     projection production stopped issuing. `proceeded_at` was in this suffix
     until 2026-08-18; note that removing it from the route WITHOUT removing it
     here left this test GREEN while describing the wrong world, which is why
     it is spelled out rather than derived. */
  return `${stringExpressionValue(initializer).replace(/,\s*customer_po_image_b64/, "")}, paid_total_centi, balance_centi_live`
    .split(", ")
    .map((column) => column.trim());
};

test("scale contract remains attached to current production route surfaces", async () => {
  const [soRoute, productRoute, usersRoute] = await Promise.all([
    readRoute("../src/scm/routes/mfg-sales-orders.ts"),
    readRoute("../src/scm/routes/mfg-products.ts"),
    readRoute("../src/routes/users.ts"),
  ]);

  assert.match(soRoute, /mfg_sales_orders_with_payment_totals/);
  assert.match(soRoute, /\.order\(sortCol, \{ ascending: sortAsc \}\)/);
  assert.match(soRoute, /q = q\.range\(page \* pageSize, page \* pageSize \+ pageSize - 1\)/);
  assert.match(soRoute, /\.from\('mfg_sales_order_items'\)/);
  assert.match(productRoute, /\.from\('mfg_products'\)/);
  assert.match(productRoute, /model:product_models\(allowed_options\)/);
  assert.match(productRoute, /return q\.range\(from, to\)/);
  assert.match(usersRoute, /search \? built\.limit\(50\) : built/);
  assert.match(usersRoute, /SELECT string_agg\(ub\.brand, chr\(31\)\)/);

  // The benchmark appends company_id only as an assertion-only probe. Every
  // actual list projection column must remain byte-for-byte aligned with the
  // runtime HEADER/LIST_COLS expression so route/schema drift fails default CI.
  assert.deepEqual(
    SO_LIST_COLUMNS.split(", ").map((column) => column.trim()),
    [...productionSoListColumns(soRoute), "company_id"],
  );
});
