// Browser check for the Change (Transform) workspace at 1440 and 2400 px.
// Usage: node scripts/ui-transform-shots.mjs [baseUrl]
// Needs playwright-core and an installed Chromium; set CHROME_PATH to override.
import {chromium} from "playwright-core";
import {existsSync,mkdirSync} from "node:fs";
import {join} from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const OUT = process.env.COMFYFIELD_QA_OUTPUT || join(process.cwd(), ".comfyfield", "qa", "screenshots");
const CANDIDATES = [
  process.env.CHROME_PATH,
].filter(Boolean);
const executablePath = CANDIDATES.find(path => existsSync(path));
if (!executablePath) throw new Error("no Chromium found; set CHROME_PATH");
mkdirSync(OUT, {recursive: true});

/* The Change screen shows four picture cards since the 2026-10 redesign; the older
   three-tab layout no longer exists, so the check follows the cards. */
const CARDS = [
  ["Swap a face", "person"],
  ["Copy moves", "motion"],
  ["Swap a thing", "swap"],
  ["New look", "restyle"],
];

const browser = await chromium.launch({executablePath, headless: true, args: ["--disable-gpu", "--no-sandbox"]});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

  await page.goto(`${BASE}/#video/transform`, {waitUntil: "networkidle"});
  await page.waitForTimeout(2500);
  const visible = await page.evaluate(labels => labels.filter(label => [...document.querySelectorAll("button")].some(button => (button.textContent ?? "").trim().startsWith(label))), CARDS.map(([label]) => label));
  console.log(`change cards visible: ${visible.length}/${CARDS.length} (${visible.join(", ")})`);
  if (!visible.length) throw new Error("Change workspace did not render; check auth or the hash route");

  for (const [width, height] of [[1440, 1000], [2400, 1400]]) {
    await page.setViewportSize({width, height});
    await page.waitForTimeout(700);
    for (const [label, slug] of CARDS) {
      await page.goto(`${BASE}/#video/transform`, {waitUntil: "domcontentloaded"});
      await page.waitForTimeout(1400);
      const card = page.locator("button", {hasText: label}).first();
      if (!(await card.count())) { console.log(`skip ${label}: not a card on this screen`); continue; }
      await card.click({force: true});
      await page.waitForTimeout(1600);
      const file = join(OUT, `transform-${slug}-${width}.png`);
      await page.screenshot({path: file, fullPage: false});
      console.log(`shot ${file}`);
      if (slug === "restyle") {
        const presets = await page.getByRole("radio", {name: /Noir|Golden hour|Neon night|Hand-painted/}).count();
        console.log(`restyle look presets: ${presets}`);
      }
    }
  }
  if (errors.length) console.log(`browser errors: ${errors.slice(0, 5).join(" | ")}`);
} finally {
  await browser.close();
}
