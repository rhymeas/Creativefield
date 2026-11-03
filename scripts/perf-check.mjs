// Measure route load timings and API latency on the local build.
import {chromium} from "playwright-core";
import fs from "node:fs";

const exe = process.env.CHROME_PATH;
const workspace = process.env.COMFYFIELD_WORKSPACE;
const project = process.env.COMFYFIELD_PROJECT;
if (!exe || !workspace || !project) throw new Error("Set CHROME_PATH, COMFYFIELD_WORKSPACE and COMFYFIELD_PROJECT.");
const routes = ["#video", "#video/storyboard", "#video/replace", "#image", "#influencer", "#library"];
const browser = await chromium.launch({executablePath: exe, headless: true, args: ["--disable-gpu", "--no-sandbox"]});
const page = await browser.newPage({viewport: {width: 1600, height: 1200}});
console.log("route            dcl(ms)  load(ms)  panel(ms)");
for (const route of routes) {
  const started = Date.now();
  await page.goto(`http://127.0.0.1:8787/${route}`, {waitUntil: "load", timeout: 30000});
  const loadMs = Date.now() - started;
  const timings = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return {dcl: Math.round(nav?.domContentLoadedEventEnd ?? 0), load: Math.round(nav?.loadEventEnd ?? 0)};
  });
  const panelStart = Date.now();
  await page.locator(".ds-panel, .cf-production, .cf-team__content, .ds-block").first().waitFor({state: "visible", timeout: 20000}).catch(() => {});
  const panelMs = Date.now() - panelStart;
  console.log(`${route.padEnd(16)} ${String(timings.dcl).padStart(7)} ${String(loadMs).padStart(8)} ${String(panelMs).padStart(9)}`);
}

const api = await page.evaluate(async ({workspace,project}) => {
  const paths = [`/api/v1/workspaces/${workspace}/catalogue`, `/api/v1/workspaces/${workspace}/assets?projectId=${project}&limit=50`, `/api/v1/workspaces/${workspace}/storyboards?projectId=${project}`];
  const out = [];
  for (const path of paths) {
    const t0 = performance.now();
    const response = await fetch(path);
    await response.json();
    out.push({path: path.split("/").slice(-1)[0].split("?")[0], ms: Math.round(performance.now() - t0), status: response.status});
  }
  return out;
}, {workspace,project});
console.log("\nAPI");
for (const row of api) console.log(`  ${row.path.padEnd(12)} ${String(row.ms).padStart(5)} ms  HTTP ${row.status}`);

const dist = [];
for (const dir of ["dist/assets"]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    const stat = fs.statSync(`${dir}/${file}`);
    if (/\.(js|css)$/.test(file)) dist.push({file, kb: Math.round(stat.size / 1024), mtime: stat.mtimeMs});
  }
}
/* Every build keeps its hashed chunks so an open tab keeps working, so the folder holds the whole
   history. Reporting that sum as "the bundle" overstates the app by a factor of many — measure the
   build that index.html actually points at, and say how much of the folder is history. */
const html = fs.existsSync("dist/index.html") ? fs.readFileSync("dist/index.html", "utf8") : "";
const entry = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
const entryCss = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.css)/)?.[1];
/* The entry chunk imports the app chunk by name, so the set the browser downloads is exactly
   those two plus whatever the entry names — not everything that ever sat in the folder. */
const named = new Set([entry, entryCss].filter(Boolean));
if (entry) {
  const source = fs.existsSync(`dist/assets/${entry}`) ? fs.readFileSync(`dist/assets/${entry}`, "utf8") : "";
  for (const match of source.matchAll(/([A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css))/g)) named.add(match[1]);
}
const current = dist.filter(item => named.has(item.file));
const history = dist.filter(item => !named.has(item.file));
const kb = list => list.reduce((sum, item) => sum + item.kb, 0);
dist.sort((a, b) => b.kb - a.kb);
console.log(`\ncurrent build${entry ? ` (${entry}${entryCss ? ` + ${entryCss}` : ""})` : ""}: ${current.length} files, ${kb(current)} KB`);
for (const item of current.sort((a, b) => b.kb - a.kb)) console.log(`  ${item.file.padEnd(34)} ${item.kb} KB`);
console.log(`earlier builds kept for open tabs: ${history.length} files, ${kb(history)} KB`);
console.log(`heaviest files in the folder:`);
for (const item of dist.slice(0, 3)) console.log(`  ${item.file.padEnd(34)} ${item.kb} KB`);
await browser.close();
