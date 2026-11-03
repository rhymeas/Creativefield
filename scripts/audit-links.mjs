// Arriving by address must equal arriving by click. A cold load has no data yet, so a guard that
// reads readiness too early silently sends a deep link somewhere else — that happened to
// #video/effects and #video/edit. Usage: npm run audit:links (app must be running).
import {chromium} from "playwright-core";

const BASE = process.env.COMFYFIELD_API?.replace(/\/api\/v1$/, "") ?? "http://127.0.0.1:8787";
const CHROME = process.env.COMFYFIELD_CHROME ?? process.env.CHROME_PATH;

// The tab label is what a person clicks; the address is what they would bookmark.
const modes = [
  ["Create", "#video/create"],
  ["Change", "#video/transform"],
  ["Edit", "#video/edit"],
  ["Effects", "#video/effects"],
];

const browser = await chromium.launch({executablePath: CHROME, headless: true, args: ["--disable-gpu", "--no-sandbox"]});
try {
  const probe = await fetch(`${BASE}/api/v1/health`).catch(() => null);
  /* Say "the app is not running" instead of throwing a navigation error per mode. */
  if (!probe?.ok) {
    console.log(`the app is not answering at ${BASE} — start it with npm start, then run this again.`);
    process.exit(1);
  }
  const readPanel = page => page.evaluate(() => {
    const text = (document.querySelector(".cf-production .ds-panel")?.innerText ?? "").split("\n").map(line => line.trim()).filter(Boolean);
    const model = text.find(line => /^[A-Z0-9][A-Z0-9 .\-—]{4,}$/.test(line));
    return (model ?? text.slice(0, 3).join(" / ")).slice(0, 56);
  });

  /* Fixed waits made this flaky under load: inside check:all the panel sometimes had not rendered
     within four seconds, so a mode was compared while still blank. Wait for the text to stop
     changing instead, with a ceiling. */
  const settle = async page => {
    let previous = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const text = await readPanel(page);
      if (text && text === previous) return text;
      previous = text;
      await page.waitForTimeout(500);
    }
    return previous ?? "";
  };

  let differing = 0;
  for (const [tab, hash] of modes) {
    const cold = await browser.newPage({viewport: {width: 1440, height: 900}});
    await cold.goto(`${BASE}/${hash}`, {waitUntil: "domcontentloaded", timeout: 20000});
    const coldPanel = await settle(cold);
    await cold.close();

    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    await page.goto(`${BASE}/#video`, {waitUntil: "domcontentloaded", timeout: 20000});
    await settle(page);
    const button = page.locator("button").filter({hasText: new RegExp(`^${tab}$`)}).first();
    if (await button.count()) { await button.click({force: true}); }
    const clickPanel = await settle(page);
    await page.close();

    const same = coldPanel === clickPanel && coldPanel !== "";
    if (!same) differing++;
    console.log(`${same ? "ok  " : "DIFF"} ${tab.padEnd(9)} address: ${coldPanel.padEnd(46)} tab: ${clickPanel}`);
  }
  console.log(`\nmodes compared: ${modes.length}, disagreeing: ${differing}`);
  await browser.close();
  process.exit(differing ? 1 : 0);
} catch (error) {
  await browser.close().catch(() => {});
  console.log(`the link audit could not finish: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
