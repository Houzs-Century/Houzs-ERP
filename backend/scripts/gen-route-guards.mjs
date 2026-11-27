import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTE_GUARDS_JSON, routeGuardsJson } from "./lib/route-guards.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = path.join(repo, ROUTE_GUARDS_JSON);
const want = routeGuardsJson();
const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
if (process.argv.includes("--check")) {
  if (have !== want) {
    console.error(`${ROUTE_GUARDS_JSON} is stale: frontend/src/App.tsx route guards changed. Run: npm --prefix backend run gen:route-guards`);
    process.exit(1);
  }
  console.log("route guards OK");
} else {
  fs.writeFileSync(file, want);
  console.log(`wrote ${ROUTE_GUARDS_JSON}`);
}
