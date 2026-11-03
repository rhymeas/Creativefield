// Read-only browser audit of every studio route/mode: does it render, does it
// throw, and is a primary action reachable? Needs playwright-core + Chromium.
// Usage: node scripts/ui-route-audit.mjs [baseUrl]

import {chromium} from "playwright-core";
import {existsSync,mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const OUT = join(process.cwd(), ".comfyfield", "qa");
const CANDIDATES = [
  process.env.CHROME_PATH,
].filter(Boolean);
const executablePath = CANDIDATES.find(path => existsSync(path));
if (!executablePath) throw new Error("no Chromium found; set CHROME_PATH");
mkdirSync(OUT, {recursive: true});

const ROUTES = [
  ["video/create", "#video", "Create"],
  ["video/storyboard", "#video/storyboard", "Storyboard"],
  ["video/transform", "#video/transform", "Transform"],
  ["video/trim", "#video/trim", "Trim"],
  ["video/replace", "#video/replace", "Replace"],
  ["motion", "#motion", "Motion"],
  ["image", "#image", "Image"],
  ["imageedit", "#imageedit", "Image Edit"],
  ["characters", "#characters", "Cast"],
  ["influencer", "#influencer", "Scenes"],
  ["marketing", "#marketing", "Marketing"],
  ["audio", "#audio", "Audio"],
  ["models", "#models", "Models"],
  ["nodes", "#nodes", "Nodes"],
  ["3d", "#3d", "3D"],
  ["library", "#library", "Library"],
  ["projects", "#projects", "Projects"],
  ["design system", "#ds", "Design"],
];

const browser = await chromium.launch({executablePath, headless: true, args: ["--disable-gpu", "--no-sandbox"]});
const results = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  let errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  for (const [name, hash, label] of ROUTES) {
    errors = [];
    try {
      await page.goto(`${BASE}/${hash}`, {waitUntil: "domcontentloaded", timeout: 20000});
    } catch (error) {
      results.push({name, hash, label, rendered: false, headingPresent: false, actions: 0, primary: [], errors: [String(error).slice(0, 200)], blank: true, navigation: "timeout"});
      console.log(`${name}: NAVIGATION TIMEOUT`);
      continue;
    }
    await page.waitForTimeout(2200);
    const body = await page.locator("body").innerText();
    const actions = await page.locator('button:visible, a[href^="#"]:visible').evaluateAll(nodes => nodes
      .map(node => ({text: (node.textContent ?? "").trim().slice(0, 48), disabled: node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled")}))
      .filter(item => item.text));
    const primary = actions.filter(item => /queue|generate|create|render|replace|apply|assemble|plan|save|start/i.test(item.text));
    // A main action that cannot run must say why in plain view (DS rule 10/26).
    const generate = await page.locator(".ds-generate").evaluateAll(nodes => nodes.map(node => ({
      text: (node.textContent ?? "").trim().slice(0, 40),
      off: node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled"),
      busy: !!node.querySelector(".ds-sparkle, [class*='sparkle']"),
      reason: (node.closest(".ds-generate-wrap")?.querySelector(".ds-generate__reason")?.textContent ?? "").trim().slice(0, 160) || null,
      describedBy: node.getAttribute("aria-describedby") || null,
    })));
    const silentOff = generate.filter(item => item.off && !item.busy && !item.reason && !item.describedBy);
    results.push({
      name, hash, label,
      rendered: body.trim().length > 0,
      headingPresent: body.includes(label),
      actions: actions.length,
      primary: primary.slice(0, 8),
      generate,
      silentOff: silentOff.length,
      errors: errors.filter(text => !/favicon|404/i.test(text)),
      blank: body.trim().length < 40,
    });
    console.log(`${name}: rendered=${body.trim().length > 0} actions=${actions.length} primary=${primary.length} generate=${generate.length} silentOff=${silentOff.length} errors=${errors.filter(t => !/favicon|404/i.test(t)).length}`);
  }
  writeFileSync(join(OUT, "route-audit.json"), JSON.stringify(results, null, 2));
  const bad = results.filter(item => item.name !== "design system" && (!item.rendered || item.blank || item.errors.length || item.silentOff > 0));
  console.log(`\nproblems: ${bad.length}`);
  for (const item of bad) console.log(`- ${item.name}: rendered=${item.rendered} blank=${item.blank} errors=${item.errors.join(" | ").slice(0, 300)}`);
} finally {
  await browser.close();
}
