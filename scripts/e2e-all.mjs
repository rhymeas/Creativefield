import { spawnSync } from "node:child_process";

// Opt-in end-to-end suite. Every child script uses the real ComfyField API and
// the configured live ComfyUI worker; nothing here is a fixture.
const scripts = [
  ["e2e:real", "scripts/e2e-real.mjs"],
  ["e2e:interpolate", "scripts/frame-interpolation-e2e.mjs"],
  ["e2e:flux-edit", "scripts/flux-edit-e2e.mjs"],
  ["e2e:storyboard", "scripts/storyboard-e2e.mjs"],
  ["e2e:motion", "scripts/motion-e2e.mjs"],
  ["e2e:masked", "scripts/masked-edit-e2e.mjs"],
];
const worker = (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");

if (process.env.COMFYFIELD_E2E !== "1") {
  console.error("e2e:all is opt-in: set COMFYFIELD_E2E=1 to run real GPU pipelines");
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForWorker(limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${worker}/system_stats`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return;
    } catch {
      // worker is restarting or busy
    }
    await sleep(2000);
  }
  throw new Error(`ComfyUI did not answer at ${worker} within ${limitMs / 1000}s`);
}

// Wan model swaps can leave the worker's HTTP loop unresponsive until memory is
// released. Reset explicitly before each suite so one heavy run cannot stall the next.
async function releaseWorker() {
  console.log(`releasing ComfyUI memory at ${worker}`);
  try {
    const response = await fetch(`${worker}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) console.warn(`ComfyUI /free returned HTTP ${response.status}`);
  } catch (error) {
    console.warn(`ComfyUI /free failed: ${error.message}`);
  }
  await waitForWorker(90000);
}

const started = Date.now();
try {
  await releaseWorker();
  for (const [label, script] of scripts) {
    console.log(`\n=== ${label} ===`);
    const step = Date.now();
    await releaseWorker();
    const result = spawnSync(process.execPath, [script], {
      stdio: "inherit",
      env: { ...process.env, COMFYFIELD_E2E: "1" },
    });
    if (result.status !== 0) {
      console.error(`\n${label} FAILED after ${((Date.now() - step) / 1000).toFixed(1)}s`);
      process.exit(result.status ?? 1);
    }
    console.log(`${label} passed in ${((Date.now() - step) / 1000).toFixed(1)}s`);
  }
} catch (error) {
  console.error(`\ne2e:all FAILED: ${error.message}`);
  process.exit(1);
}
console.log(`\ne2e:all OK T2V, I2V, FLF, interpolation, Flux image edit, storyboard, motion and masked edit in ${((Date.now() - started) / 1000).toFixed(1)}s`);
