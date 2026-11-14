/*
 * Measures where reference-video ingestion spends its time and what a local
 * decision model would change. Run with:
 *
 *   npx tsx scripts/decision-benchmark.ts
 *
 * It is a dev tool, not part of the app: it times the server cut scan for real
 * example clips, times one full browser analysis pass, and compares the current
 * "send up to 8 frames, one VLM call" strategy with a triage plan.
 */
import {readFileSync, writeFileSync} from "node:fs";
import {chromium} from "playwright-core";
import {buildShotCards, routeShotAnalysis} from "../src/film-studio/decision";

const APP = "http://127.0.0.1:8787/#block/film";
const WORKSPACE = "51cdde46-e5f3-467d-a6fc-2e468846d39f";
const CLIPS = [
  {name: "storyboard (3s, 4 cuts)", url: "/examples/features/storyboard.mp4"},
  {name: "angles (3s, no cuts)", url: "/examples/menu/angles.mp4"},
  {name: "promo v3 (76s, 37 cuts)", url: "/examples/creativefield-promo-v3.mp4"},
];
const STAGING_SECONDS = 20; // measured for one VLM staging call on this machine
const FRAMES_PER_CALL = 8;

type Row = {
  clip: string;
  scanMs: number | null;
  cutScanCuts: number | null;
  scanError?: string;
  clientPhases?: Record<string, number>;
  analysisMs?: number | null;
  analysisError?: string;
  shots: number | null;
  plan: {analyze: number; skipped: number; frames: number; reason: string} | null;
  aiBatchesAllShots: number | null;
  aiSecondsAllShots: number | null;
  aiSecondsWithTriage: number | null;
  speedup: number | null;
};

const round = (value: number) => Math.round(value * 10) / 10;

async function main() {
  const browser = await chromium.launch({channel: "chrome", headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  await page.goto(APP, {waitUntil: "load", timeout: 90_000});
  await page.waitForTimeout(5000);
  const create = page.getByRole("button", {name: "Let's create"});
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(800);
  }

  // 1) Server cut scan for each example clip, measured inside the page.
  const rows: Row[] = [];
  for (const clip of CLIPS) {
    const measured = await page.evaluate(async ({url, workspaceId}) => {
      const blob = await (await fetch(url)).blob();
      const form = new FormData();
      form.append("file", blob, url.split("/").pop() ?? "clip.mp4");
      const started = performance.now();
      const response = await fetch(`/api/v1/workspaces/${workspaceId}/reference-shots`, {method: "POST", body: form, credentials: "same-origin"});
      const ms = performance.now() - started;
      const payload = response.ok ? await response.json() : {error: (await response.text()).slice(0, 300)};
      return {status: response.status, ms, payload};
    }, {url: clip.url, workspaceId: WORKSPACE});
    if (measured.status !== 200) {
      rows.push({clip: clip.name, scanMs: round(measured.ms), cutScanCuts: null, scanError: JSON.stringify(measured.payload).slice(0, 200), shots: null, plan: null, aiBatchesAllShots: null, aiSecondsAllShots: null, aiSecondsWithTriage: null, speedup: null});
      continue;
    }
    const result = measured.payload as {durationSec: number; cuts: number[]; shots: unknown[]};
    const cards = buildShotCards(result.cuts, result.durationSec);
    const plan = routeShotAnalysis(cards);
    const allBatches = Math.ceil(cards.length / FRAMES_PER_CALL);
    const triageSeconds = plan.analyze.length > FRAMES_PER_CALL ? Math.ceil(plan.analyze.length / FRAMES_PER_CALL) * STAGING_SECONDS : plan.analyze.length ? STAGING_SECONDS : 0;
    rows.push({
      clip: clip.name,
      scanMs: round(measured.ms),
      cutScanCuts: result.cuts.length,
      shots: cards.length,
      plan: {analyze: plan.analyze.length, skipped: plan.skipped.length, frames: plan.totalFrames, reason: plan.reason},
      aiBatchesAllShots: allBatches,
      aiSecondsAllShots: allBatches * STAGING_SECONDS,
      aiSecondsWithTriage: triageSeconds,
      speedup: triageSeconds ? round((allBatches * STAGING_SECONDS) / triageSeconds) : null,
    });
  }

  // 2) One full browser pass on the 3 s storyboard clip: where does the time go?
  const phases: Record<string, number> = {};
  const start = Date.now();
  await page.getByRole("tab", {name: "Clip"}).click();
  await page.waitForTimeout(400);
  await page.locator('input[type="file"]').first().setInputFiles("public/examples/features/storyboard.mp4");
  let lastKey = "";
  for (let index = 0; index < 600; index++) {
    const text = await page.evaluate(() => document.body.innerText);
    const keys: Array<[string, string]> = [
      ["cuts", "Finding shot cuts"],
      ["reading", "Reading the reference"],
      ["readingShots", "Reading 5 shots"],
      ["result", "shots detected from the clip"],
      ["error", "could not be analysed"],
    ];
    for (const [key, marker] of keys) {
      if (!phases[key] && text.includes(marker)) phases[key] = Date.now() - start;
    }
    const key = Object.keys(phases).sort().join(",");
    if (key !== lastKey) lastKey = key;
    if (phases.result || phases.error) break;
    await page.waitForTimeout(100);
  }
  const storyboard = rows.find((row) => row.clip.startsWith("storyboard"));
  if (storyboard) {
    storyboard.clientPhases = phases;
    storyboard.analysisMs = phases.result || phases.error ? (phases.result ?? phases.error) - (phases.cuts ?? start) : null;
    if (phases.error) storyboard.analysisError = "The AI staging call failed (for example ChatGPT plan limit).";
  }

  await browser.close();
  const stamp = new Date().toISOString();
  writeFileSync("output/stageflow-re/decision-benchmark.json", JSON.stringify({stamp, stagingSeconds: STAGING_SECONDS, framesPerCall: FRAMES_PER_CALL, rows}, null, 2));
  console.table(rows.map((row) => ({
    Clip: row.clip,
    "Cut scan ms": row.scanMs,
    Cuts: row.cutScanCuts,
    Shots: row.shots,
    "Triage shots": row.plan?.analyze ?? "",
    "AI calls (all)": row.aiBatchesAllShots ?? "",
    "AI s (all)": row.aiSecondsAllShots ?? "",
    "AI s (triage)": row.aiSecondsWithTriage ?? "",
    "Speed-up": row.speedup ? `${row.speedup}x` : "",
  })));
  console.log("Client phases:", JSON.stringify(phases));
  console.log("Written output/stageflow-re/decision-benchmark.json");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
