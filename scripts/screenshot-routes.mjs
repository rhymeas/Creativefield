// Capture and compare primary screens at multiple viewport widths.
//
//   node scripts/screenshot-routes.mjs                    compare against the baseline
//   node scripts/screenshot-routes.mjs --baseline         write a new baseline
//   node scripts/screenshot-routes.mjs --allow models,nodes
//   node scripts/screenshot-routes.mjs --only models --width 1440
//   node scripts/screenshot-routes.mjs --base http://127.0.0.1:8787 --out <dir> --diffs <dir>
//
// Needs playwright-core and an installed Chromium; set CHROME_PATH to override.
// Signs in with the local single-user session (/api/v1/auth/me), never a real password.
import {chromium} from "playwright-core";
import {createHash} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,relative} from "node:path";
import sharp from "sharp";
import {compareManifests,formatTable} from "./screenshot-diff-lib.mjs";

const BASE = flag("--base") ?? "http://127.0.0.1:8787";
const MANIFEST_VERSION = 1;
const VIEWPORTS = [
  {width: 1440, height: 900},
  {width: 2400, height: 1350},
];

/* The primary screens: everything in route-state.ts ROUTES that a person visits on purpose,
   plus the storyboard mode and the design-system showcase. `expect` is the text that proves
   the screen rendered; without it the body must carry real text. */
const ROUTES = [
  {name: "make", hash: "#make", expect: "All tools"},
  {name: "video", hash: "#video"},
  {name: "video-transform", hash: "#video/transform"},
  {name: "video-edit", hash: "#video/edit"},
  {name: "storyboard", hash: "#video/storyboard"},
  {name: "image", hash: "#image"},
  {name: "imageedit", hash: "#imageedit"},
  {name: "3d", hash: "#3d"},
  {name: "3d-image", hash: "#3d/image"},
  {name: "3d-text", hash: "#3d/text"},
  {name: "3d-mesh", hash: "#3d/mesh"},
  {name: "3d-texture", hash: "#3d/texture"},
  {name: "3d-viewer", hash: "#3d/viewer"},
  {name: "audio", hash: "#audio", expect: "Type the words"},
  {name: "nodes", hash: "#nodes", readySelector: ".cf-nodes"},
  {name: "motion", hash: "#motion"},
  {name: "characters", hash: "#characters"},
  {name: "library", hash: "#library"},
  {name: "projects", hash: "#projects"},
  {name: "models", hash: "#catalogue"},
  {name: "ds", hash: "#ds"},
];

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.CHROME_PATH,
  process.env.CHROME_PATH,
].filter(Boolean);

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "true";
}
const has = (name) => process.argv.includes(name);

const writeBaseline = has("--baseline");
const allowFile = flag("--allow-file");
const allowInline = flag("--allow");
const allow = allowFile && allowFile !== "true"
  ? JSON.parse(readFileSync(allowFile, "utf8"))
  : allowInline && allowInline !== "true"
    ? allowInline.split(",").map((route) => route.trim()).filter(Boolean)
    : undefined;
const only = (flag("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const widths = flag("--width") ? [Number(flag("--width"))] : VIEWPORTS.map((v) => v.width);
const baselineDir = flag("--out") ?? "docs/screens/baseline";
const currentDir = flag("--current") ?? join(".comfyfield", "screens", "current");
const diffDir = flag("--diffs") ?? join(".comfyfield", "screens", "diff");
const settle = Number(flag("--settle") ?? 900);

const executablePath = CANDIDATES.find((path) => existsSync(path));
if (!executablePath) throw new Error("no Chromium found; set CHROME_PATH");
const outDir = writeBaseline ? baselineDir : currentDir;
mkdirSync(outDir, {recursive: true});
mkdirSync(diffDir, {recursive: true});

const ROUTES_TO_SHOT = only.length ? ROUTES.filter((route) => only.includes(route.name)) : ROUTES;
if (!ROUTES_TO_SHOT.length) throw new Error(`no route matches --only ${only.join(",")}`);

/** Freeze everything that would move between two runs: reels, transitions, the caret and the clock. */
async function freeze(page) {
  await page.emulateMedia({reducedMotion: "reduce"});
  // Wait for each clip to actually show its first frame; a seek that lands after the screenshot is
  // exactly what made one run's hero picture differ from the next.
  await page.evaluate(async () => {
    const clips = [...document.querySelectorAll("video")];
    await Promise.all(clips.map((video) => new Promise((resolve) => {
      try {
        video.pause();
        video.muted = true;
        if (video.readyState < 2) {
          video.addEventListener("loadeddata", () => resolve(), {once: true});
          video.addEventListener("error", () => resolve(), {once: true});
          return;
        }
        if (video.currentTime !== 0) {
          video.addEventListener("seeked", () => resolve(), {once: true});
          video.currentTime = 0;
          return;
        }
      } catch { /* nothing to freeze */ }
      resolve();
    })));
  });
}

/**
 * Stop time. Timers, `Date.now` and `requestAnimationFrame` are faked at a fixed instant, so a
 * late poll or a relative timestamp cannot redraw the screen between the first try and the last
 * frame of an otherwise identical build. Older playwright-core falls back to the frame check.
 */
async function freezeClock(page) {
  try {
    await page.clock.install({time: new Date("2026-10-28T12:00:00.000Z")});
    return true;
  } catch {
    return false;
  }
}

/** Readiness: the expected text, the expected element, or at least real text on the screen. */
async function readiness(page, route) {
  if (route.readySelector) {
    try {
      await page.waitForSelector(route.readySelector, {timeout: 20000});
      return {ready: true};
    } catch {
      /* the screen may be showing its empty state instead; the body check decides */
    }
  }
  if (route.expect) {
    try {
      await page.getByText(route.expect, {exact: false}).first().waitFor({timeout: 15000});
      return {ready: true};
    } catch {
      /* fall through to the body check, so the run reports the screen instead of dying */
    }
  }
  const bodyChars = await page.evaluate(() => (document.body.innerText ?? "").replace(/\s+/g, " ").trim().length);
  return {ready: bodyChars >= 40, bodyChars};
}

/**
 * The picture is taken only once three frames in a row are identical, so a screen that is still
 * settling (a fetch resolving, a reel swapping in) cannot make two runs disagree.
 */
async function stableShot(page, path) {
  let previous = null;
  let matches = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    // A clip can remount between attempts (React redraws the hero), so freeze before every frame.
    await freeze(page);
    const buffer = await page.screenshot({animations: "disabled", caret: "hide", scale: "css", fullPage: false});
    matches = previous && buffer.equals(previous) ? matches + 1 : 0;
    previous = buffer;
    if (matches >= 2) {
      writeFileSync(path, buffer);
      return {stable: true, tries: attempt + 1};
    }
    await page.waitForTimeout(400);
  }
  writeFileSync(path, previous);
  return {stable: false, tries: 12};
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Count pixels that differ, and draw them so the change can be seen. */
async function diffPixels(baselinePath, currentPath, diffPath) {
  const [was, is] = await Promise.all([sharp(baselinePath).ensureAlpha().raw().toBuffer({resolveWithObject: true}), sharp(currentPath).ensureAlpha().raw().toBuffer({resolveWithObject: true})]);
  if (was.info.width !== is.info.width || was.info.height !== is.info.height) return {changedPixels: null, note: "size changed"};
  const {width, height} = was.info;
  const mask = Buffer.alloc(width * height * 4);
  let changed = 0;
  for (let index = 0; index < width * height; index++) {
    const at = index * 4;
    const delta = Math.abs(was.data[at] - is.data[at]) + Math.abs(was.data[at + 1] - is.data[at + 1]) + Math.abs(was.data[at + 2] - is.data[at + 2]);
    if (delta > 12) {
      changed++;
      mask[at] = 255; mask[at + 1] = 40; mask[at + 2] = 90;
    } else {
      mask[at] = is.data[at]; mask[at + 1] = is.data[at + 1]; mask[at + 2] = is.data[at + 2];
    }
    mask[at + 3] = 255;
  }
  if (changed) await sharp(mask, {raw: {width, height, channels: 4}}).png().toFile(diffPath);
  return {changedPixels: changed};
}

const browser = await chromium.launch({executablePath, headless: true, args: ["--disable-gpu", "--no-sandbox", "--force-color-profile=srgb", "--font-render-hinting=none"]});
const entries = [];
const problems = [];
// Which workers answer is part of the picture: a stopped ComfyUI turns the composer, the Models
// modal and the Nodes screen into different screens. Record it, so a diff can be attributed to a
// machine state instead of being "fixed" by accepting a baseline.
let machine = {workers: null};
try {
  const probe = await chromium.launch({executablePath, headless: true, args: ["--disable-gpu", "--no-sandbox"]});
  try {
    const context = await probe.newContext();
    await context.request.get(`${BASE}/api/v1/auth/me`);
    const workspaces = await (await context.request.get(`${BASE}/api/v1/workspaces`)).json();
    const workspace = workspaces?.[0];
    if (workspace) {
      const list = await (await context.request.get(`${BASE}/api/v1/workspaces/${workspace.id}/workers`)).json();
      machine = {workers: (list ?? []).filter((worker) => worker.enabled).map((worker) => `${worker.name}:${worker.inventory?.online ? "online" : "offline"}`).sort()};
    }
    await context.close();
  } finally {
    await probe.close();
  }
  if (machine.workers) console.log(`workers: ${machine.workers.join(", ")}`);
} catch (error) {
  console.log(`workers: could not be read (${error.message})`);
}
try {
  for (const width of widths) {
    const height = VIEWPORTS.find((v) => v.width === width)?.height ?? Math.round(width * 0.625);
    const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce"});
    // The project's own local session; LOCAL_SINGLE_USER=1 signs in on first use. No password.
    const auth = await context.request.get(`${BASE}/api/v1/auth/me`);
    if (!auth.ok()) throw new Error(`sign-in failed: ${auth.status()} ${await auth.text()}`);
    const who = await auth.json();
    console.log(`signed in as ${who.email}${who.localSingleUser ? " (local single user)" : ""} at ${width}px`);

    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`${width}px page error: ${error.message}`));
    // Warm the app up once before the first picture: the first load after a server restart is
    // slower (bundle, fonts, catalogue), and capturing it caught a half-built screen.
    await page.goto(`${BASE}/#make`, {waitUntil: "domcontentloaded", timeout: 90000});
    await page.waitForSelector(".ds-topbar", {timeout: 30000}).catch(() => {});
    await page.waitForLoadState("networkidle", {timeout: 15000}).catch(() => {});
    for (const route of ROUTES_TO_SHOT) {
      await page.goto("about:blank");
      // Not networkidle: a screen that holds a live connection to a running ComfyUI (the node
      // editor, a queued job) never goes idle, and waiting for it timed the route out.
      await page.goto(`${BASE}/${route.hash}`, {waitUntil: "domcontentloaded", timeout: 60000});
      await freeze(page);
      const state = await readiness(page, route);
      if (route.expect && !state.ready) state.bodyChars = await page.evaluate(() => (document.body.innerText ?? "").trim().length);
      await page.waitForTimeout(settle);
      await page.waitForLoadState("networkidle", {timeout: 15000}).catch(() => {});
      await freeze(page);
      const clockFrozen = await freezeClock(page);
      const file = join(outDir, `${route.name}@${width}.png`);
      const shot = await stableShot(page, file);
      if (!shot.stable) problems.push(`${route.name}@${width} never stopped changing, so its picture cannot be compared`);
      const entry = {route: route.name, hash: route.hash, width, height, file: relative(process.cwd(), file).replaceAll("\\", "/"), sha256: sha256(file), ready: state.ready, bodyChars: state.bodyChars ?? null, stable: shot.stable, clockFrozen};
      entries.push(entry);
      console.log(`  ${state.ready ? "shot" : "NOT READY"} ${route.name}@${width}${shot.stable ? "" : " (UNSTABLE)"}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const manifest = {
  version: MANIFEST_VERSION,
  capturedAt: new Date().toISOString(),
  base: BASE,
  chromium: executablePath,
  workers: machine.workers,
  viewports: widths.map((width) => ({width, height: VIEWPORTS.find((v) => v.width === width)?.height ?? Math.round(width * 0.625)})),
  entries,
};

if (writeBaseline) {
  // A partial re-baseline (--baseline --only models) replaces only the screens it captured,
  // so accepting one task's diff never drops the rest of the reference.
  const file = join(baselineDir, "manifest.json");
  const previous = only.length && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const next = {
    ...manifest,
    entries: previous
      ? [...previous.entries.filter((entry) => !only.includes(entry.route)), ...entries].sort((a, b) => (a.route === b.route ? a.width - b.width : a.route < b.route ? -1 : 1))
      : entries,
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(`\nbaseline written: ${entries.length} screen(s) in ${baselineDir} (${next.entries.length} in manifest.json)`);
  process.exit(problems.length ? 1 : 0);
}

const baselinePath = join(baselineDir, "manifest.json");
if (!existsSync(baselinePath)) {
  console.error(`no baseline at ${baselinePath}; run: node scripts/screenshot-routes.mjs --baseline`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
// A partial run (--only) compares only the screens it captured; the rest still belong to the
// baseline and are checked by a full run.
const scoped = only.length
  ? { baseline: {...baseline, entries: baseline.entries.filter((entry) => only.includes(entry.route))}, current: {...manifest, entries: entries.filter((entry) => only.includes(entry.route))} }
  : { baseline, current: manifest };
const {rows, failures, warnings} = compareManifests(scoped.baseline, scoped.current, allow);
const machineChanged = !!baseline.workers && !!manifest.workers && baseline.workers.join("|") !== manifest.workers.join("|");
if (machineChanged) {
  warnings.push(`the workers answer differently from when the baseline was taken (baseline: ${baseline.workers.join(", ")}; now: ${manifest.workers.join(", ")}). A stopped ComfyUI changes the composer, the Models modal and the Nodes screen, so diff those rows before you believe them.`);
}

// Measure the pixels of every changed screen, so the table says how much moved.
for (const row of rows) {
  if (row.status !== "changed" && row.status !== "changed-allowed") continue;
  const was = baseline.entries.find((entry) => `${entry.route}@${entry.width}` === row.key);
  const is = entries.find((entry) => `${entry.route}@${entry.width}` === row.key);
  const measured = await diffPixels(join(baselineDir, `${row.route}@${row.width}.png`), join(currentDir, `${row.route}@${row.width}.png`), join(diffDir, `${row.route}@${row.width}.diff.png`));
  row.changedPixels = measured.changedPixels;
  if (measured.note) row.note = measured.note;
  if (measured.changedPixels === 0) {
    // Same picture, different bytes (PNG encoding only): not a look change.
    row.status = "same";
    row.note = "identical pixels";
  }
}

console.log(`\n${formatTable(rows)}`);
for (const warning of warnings) console.log(`warning: ${warning}`);
for (const problem of problems) console.log(`warning: ${problem}`);
writeFileSync(join(diffDir, "summary.json"), `${JSON.stringify({base: BASE, comparedAt: manifest.capturedAt, rows, failures: failures.map((row) => row.key), warnings}, null, 2)}\n`, "utf8");

const changed = rows.filter((row) => row.status === "changed" || row.status === "changed-allowed");
if (changed.length) console.log(`\ndiff images: ${diffDir}`);
if (failures.length) {
  console.log(`\n${failures.length} unlisted difference(s): ${failures.map((row) => `${row.key} (${row.status})`).join(", ")}`);
  console.log("If a difference is intended by your task, list it: --allow <route> or --allow-file <task>.json");
  process.exit(1);
}
console.log(`\nlook-freeze holds: ${rows.length} screens, no unlisted difference.`);
