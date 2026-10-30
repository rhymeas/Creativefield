// Remove build output the current index.html does not reference. Dry run unless --force.
// Every build keeps its hashed chunks so an open tab keeps working; that history is what this
// clears. Rebuilding restores anything removed, so the risk is a stale tab, not lost source.
import fs from "node:fs";
import path from "node:path";

const force = process.argv.includes("--force");
const assets = "dist/assets";
if (!fs.existsSync(assets)) { console.log("no dist/assets — run npm run build first"); process.exit(0); }

const html = fs.existsSync("dist/index.html") ? fs.readFileSync("dist/index.html", "utf8") : "";
const named = new Set([...html.matchAll(/\/assets\/([A-Za-z0-9_-]+\.(?:js|css))/g)].map(match => match[1]));
for (const entry of [...named]) {
  const file = path.join(assets, entry);
  if (!fs.existsSync(file)) continue;
  for (const match of fs.readFileSync(file, "utf8").matchAll(/([A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css))/g)) named.add(match[1]);
}

const files = fs.readdirSync(assets).filter(name => /\.(js|css)$/.test(name));
const stale = files.filter(name => !named.has(name));
const kb = list => Math.round(list.reduce((sum, name) => sum + fs.statSync(path.join(assets, name)).size, 0) / 1024);
console.log(`current build references ${named.size} file(s), ${kb(files.filter(n => named.has(n)))} KB`);
console.log(`older chunks: ${stale.length} file(s), ${kb(stale)} KB`);
if (!stale.length) process.exit(0);
if (!force) {
  console.log("Dry run. Add --force to delete them; a rebuild restores anything removed.");
  process.exit(0);
}
for (const name of stale) fs.unlinkSync(path.join(assets, name));
console.log(`deleted ${stale.length} file(s), freed ${kb(stale)} KB`);
