// Opt-in, reproducible Transform Video evidence runner.
//
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs generate
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs motion
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs swap
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs restyle
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs vfx
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs replaceLong
//   COMFYFIELD_E2E=1 node scripts/transform-evidence.mjs all
//
// The swap stage requires COMFYFIELD_TEST_SOURCE_VIDEO_ID and
// COMFYFIELD_TEST_EDIT_MASK_ID for assets in the evidence project. The optional
// motionElement stage requires COMFYFIELD_TEST_ELEMENT_ID and
// COMFYFIELD_TEST_ELEMENT_ASSET_ID for a character in that same project.
// These must be assets created or supplied by the operator.
//
// It generates its own cleared, fictional fixtures with the app's image and
// video models, then runs Motion Transfer, Object Swap and Scene Restyle
// through the real ComfyField API and a running ComfyUI. Outputs are downloaded
// and hashed; ids are kept in .comfyfield/qa/transform/state.json so a stage
// can be re-run without regenerating its inputs.
//
// No child process is spawned: fixtures come from the model runs, and media
// facts come from the asset metadata the server decoded.

import {createHash} from "node:crypto";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";

const BASE = process.env.COMFYFIELD_URL ?? "http://127.0.0.1:8787";
const API = `${BASE}/api/v1`;
const ORIGIN = {Origin: BASE};
const ROOT = join(process.cwd(), ".comfyfield", "qa", "transform");
const STATE_FILE = join(ROOT, "state.json");
const STDIO = process.argv[2] ?? "all";
const STAGES = ["generate", "motion", "swap", "restyle", "scail"];
const EXTRA_STAGES = ["motionElement", "scail2", "replaceShort", "replaceLong", "restyleRef", "restyleRefFit", "restyleLooks", "motionMatrix", "replaceChain", "swapTracked", "swapTrackedShoes", "swapTrackedShoes2", "restyleLoft", "swapTrackedPoints", "swapMultiRegion", "swapChain", "vfx"];
const jar = new Map();

if (process.env.COMFYFIELD_E2E !== "1") {
  console.log("transform evidence is opt-in: set COMFYFIELD_E2E=1 and start ComfyField + ComfyUI first.");
  process.exit(0);
}
if ((STDIO === "all" || STDIO === "swap") && (!process.env.COMFYFIELD_TEST_SOURCE_VIDEO_ID || !process.env.COMFYFIELD_TEST_EDIT_MASK_ID)) {
  throw new Error("Set COMFYFIELD_TEST_SOURCE_VIDEO_ID and COMFYFIELD_TEST_EDIT_MASK_ID for swap");
}
if (STDIO === "motionElement" && (!process.env.COMFYFIELD_TEST_ELEMENT_ID || !process.env.COMFYFIELD_TEST_ELEMENT_ASSET_ID)) {
  throw new Error("Set COMFYFIELD_TEST_ELEMENT_ID and COMFYFIELD_TEST_ELEMENT_ASSET_ID for motionElement");
}

async function call(method, path, body, form) {
  const headers = {...ORIGIN};
  if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(API + path, {method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body))});
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(patch) {
  mkdirSync(ROOT, {recursive: true});
  const next = {...readState(), ...patch};
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(base, id, limitMs = 90 * 60 * 1000) {
  const deadline = Date.now() + limitMs;
  let state = "pending", latest = null;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      latest = await call("GET", `${base}/runs/${id}`);
      state = latest.state;
    } catch {
      // A backend restart in the middle of a long run is transient; keep polling.
      process.stdout.write("?");
      continue;
    }
    if (["succeeded", "failed", "cancelled", "submission_unknown"].includes(state)) return latest;
    process.stdout.write(".");
  }
  throw new Error(`run ${id} did not finish within ${limitMs / 60000} minutes (last state ${state})`);
}

async function download(base, assetId, name) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`${API}${base}/assets/${assetId}/content`, {
        headers: {...ORIGIN, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ")},
      });
      if (!response.ok) throw new Error(`download ${assetId} -> HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const file = join(ROOT, name);
      mkdirSync(dirname(file), {recursive: true});
      writeFileSync(file, bytes);
      return {file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
    } catch (error) {
      last = error;
      await sleep(3000);
    }
  }
  throw last;
}

async function submit(base, workerId, projectId, capability, {inputs = {}, controls = {}, presetId, elementInputs, tracking, audioPolicy = "mute"} = {}) {
  const body = {
    projectId, workerId, idempotencyKey: crypto.randomUUID(),
    capabilityId: capability.id, version: capability.version, routeId: "local",
    inputs, controls, ...(elementInputs ? {elementInputs} : {}), ...(tracking ? {tracking} : {}), ...(presetId ? {presetId} : {}), audioPolicy,
  };
  const run = await call("POST", `${base}/runs`, body);
  console.log(`\nsubmitted ${capability.id} ${run.id}`);
  return run;
}

async function runAndWait(base, workerId, projectId, capability, options, outputName) {
  const submitted = await submit(base, workerId, projectId, capability, options);
  const done = await waitFor(base, submitted.id);
  if (done.state !== "succeeded") throw new Error(`${capability.id} ${done.state}: ${done.error ?? "no error"}`);
  const outputId = done.output_ids?.[0];
  if (!outputId) throw new Error(`${capability.id} succeeded without an output`);
  let asset;
  for (let attempt = 0; ; attempt++) {
    try { asset = await call("GET", `${base}/assets/${outputId}`); break; }
    catch (error) { if (attempt >= 5) throw error; await sleep(3000); }
  }
  const file = await download(base, outputId, outputName);
  const record = {
    capabilityId: capability.id, capabilityVersion: capability.version,
    runId: submitted.id, outputId, presetId: options.presetId ?? null,
    media: {width: asset.metadata?.width, height: asset.metadata?.height, frames: asset.metadata?.frames, fps: asset.metadata?.frameRate ?? asset.metadata?.fps, seconds: asset.metadata?.durationSeconds},
    file: file.file, bytes: file.bytes, sha256: file.sha256,
  };
  console.log(`\n${capability.id} -> ${JSON.stringify(record.media)} sha256=${file.sha256.slice(0, 16)}...`);
  return record;
}

async function ensureProject(base, name) {
  const projects = await call("GET", `${base}/projects`);
  const found = projects.find(item => item.name === name);
  return found?.id ?? (await call("POST", `${base}/projects`, {name})).id;
}

async function upload(base, projectId, filename, type = "video/mp4") {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(filename)], {type}), filename.split(/[\\/]/).pop());
  return call("POST", `${base}/assets?projectId=${projectId}`, undefined, form);
}

async function main() {
  await call("GET", "/auth/me");
  const [workspace] = await call("GET", "/workspaces");
  const base = `/workspaces/${workspace.id}`;
  const workers = await call("GET", `${base}/workers`);
  const worker = workers.find(item => item.enabled && item.inventory?.online && item.kind === "local");
  if (!worker) throw new Error("no enabled, online local worker");
  const catalogue = await call("GET", `${base}/catalogue`);
  const capability = id => {
    const found = catalogue.find(item => item.id === id);
    if (!found) throw new Error(`capability ${id} is not in the catalogue`);
    if (found.coverage.local !== "implemented") throw new Error(`capability ${id} is not implemented locally`);
    return found;
  };
  const project = await ensureProject(base, "Transform evidence");
  const exportProject = await ensureProject(base, "Transform export evidence");
  if (STDIO === "collect") {
    const runId = process.argv[3];
    if (!runId) throw new Error("usage: transform-evidence.mjs collect <runId> [file] [stateKey]");
    const run = await call("GET", `${base}/runs/${runId}`);
    if (run.state !== "succeeded") throw new Error(`run ${runId} is ${run.state}: ${run.error ?? "no error"}`);
    const outputId = run.output_ids?.[0];
    if (!outputId) throw new Error(`run ${runId} has no output`);
    const asset = await call("GET", `${base}/assets/${outputId}`);
    const file = await download(base, outputId, process.argv[4] ?? "collected.mp4");
    const record = {
      capabilityId: run.capability_id, capabilityVersion: run.capability_version ?? null, runId, outputId,
      media: {width: asset.metadata?.width, height: asset.metadata?.height, frames: asset.metadata?.frames, fps: asset.metadata?.frameRate ?? asset.metadata?.fps, seconds: asset.metadata?.durationSeconds},
      file: file.file, bytes: file.bytes, sha256: file.sha256,
    };
    if (process.argv[5]) writeState({[process.argv[5]]: record});
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const state = readState();
  const stages = STDIO === "all" ? STAGES : [STDIO];
  if (stages.some(stage => ![...STAGES, ...EXTRA_STAGES].includes(stage))) throw new Error(`unknown stage ${STDIO}; use ${[...STAGES, ...EXTRA_STAGES].join(", ")} or all`);
  console.log(`worker ${worker.name ?? worker.id}, project ${project}`);

  if (stages.includes("generate")) {
    const still = capability("flux2-klein-t2i"), i2v = capability("wan22-ti2v-5b");
    let current = state;
    if (!current.character) {
      current = writeState({character: await runAndWait(base, worker.id, project, still, {
        controls: {
          prompt: "Full-body studio photograph of a fictional woman in her thirties with short dark hair, wearing a plain grey tracksuit and white trainers, standing relaxed and facing the camera, seamless light-grey studio background, soft even light, natural proportions.",
          width: 704, height: 1280, seed: 11, steps: 20,
        },
      }, "character-source.png")});
    }
    if (!current.target) {
      current = writeState({target: await runAndWait(base, worker.id, project, still, {
        controls: {
          prompt: "Full-body studio photograph of a fictional man in his sixties with a short grey beard, wearing a navy blue work jacket and grey trousers, standing relaxed and facing the camera, seamless light-grey studio background, soft even light, natural proportions.",
          width: 704, height: 1280, seed: 12, steps: 20,
        },
      }, "character-target.png")});
    }
    if (!current.style) {
      current = writeState({style: await runAndWait(base, worker.id, project, still, {
        controls: {
          prompt: "Loose watercolor painting of a quiet European side street at dusk, muted teal and warm ochre washes, visible paper texture, soft bleeding edges, no people.",
          width: 1024, height: 1024, seed: 13, steps: 20,
        },
      }, "style-reference.png")});
    }
    if (!current.driving) {
      writeState({driving: await runAndWait(base, worker.id, project, i2v, {
        inputs: {start_image: current.character.outputId},
        controls: {
          prompt: "The woman waves once with her right hand, shifts her weight and turns her head slightly, calm natural movement, the studio background stays still.",
          width: 704, height: 1280, length: 2, seed: 14,
        },
      }, "driving-performance.mp4")});
    }
  }

  if (stages.includes("motion")) {
    const animate = capability("wan-animate2-distilled");
    const current = readState();
    if (!current.target || !current.driving) throw new Error("run the generate stage first");
    const record = await runAndWait(base, worker.id, project, animate, {
      inputs: {start_image: current.target.outputId, motion_video: current.driving.outputId},
      controls: {
        prompt: "A realistic fictional man in his sixties with a short grey beard, navy blue work jacket and grey trousers, plain light-grey studio background.",
        motion_prompt: "He waves with his right hand, shifts his weight and turns his head slightly.",
        width: 482, height: 854, seed: 21,
      },
    }, "motion-transfer.mp4");
    writeState({motion: record});
  }

  if (stages.includes("scail")) {
    const scail = capability("scail2-character-replace");
    const clipPath = join(process.cwd(), "fixtures", "real", "clip-two-talking.mp4");
    if (!existsSync(clipPath)) throw new Error("fixtures/real/clip-two-talking.mp4 is missing");
    let current = readState();
    if (!current.twoPersonClip) {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(clipPath)], {type: "video/mp4"}), "clip-two-talking.mp4");
      const asset = await call("POST", `${base}/assets?projectId=${project}`, undefined, form);
      current = writeState({twoPersonClip: {assetId: asset.id}});
    }
    if (!current.target) throw new Error("run the generate stage first: the character reference is missing");
    const record = await runAndWait(base, worker.id, project, scail, {
      inputs: {source_video: current.twoPersonClip.assetId, character_image: current.target.outputId},
      controls: {
        prompt: "A realistic fictional man in his sixties with a short grey beard, wearing a navy blue work jacket, standing in the same park with the same lighting.",
        person: "0", seed: 71,
      },
    }, "character-replace-scail.mp4");
    writeState({scail: record});
  }

  if (stages.includes("scail2")) {
    const scail = capability("scail2-character-replace");
    const current = readState();
    if (!current.twoPersonClip || !current.target) throw new Error("run generate and scail first");
    // Same clip and person, but the prompt describes the real studio instead of
    // inviting a new location. This isolates replacement quality from prompt bias.
    const record = await runAndWait(base, worker.id, project, scail, {
      inputs: {source_video: current.twoPersonClip.assetId, character_image: current.target.outputId},
      controls: {
        prompt: "Two people talking in a plain light-grey studio. Replace the man on the left with a realistic fictional man in his sixties, short grey beard, navy blue work jacket. Keep the woman on the right, the grey background and the original lighting unchanged.",
        person: "0", seed: 72,
      },
    }, "character-replace-scail-studio.mp4");
    writeState({scailStudio: record});
  }

  if (stages.includes("replaceShort")) {
    const scail = capability("scail2-character-replace");
    const current = readState();
    if (!current.driving || !current.target) throw new Error("run the generate stage first");
    // 0.2.0 takes the clip window from the pose stream, so a clip of 81 frames or
    // fewer must keep its own frame count instead of being padded to 81. The
    // 49-frame driving clip is a cleared fixture under 81 frames that has a person.
    const record = await runAndWait(base, worker.id, project, scail, {
      inputs: {source_video: current.driving.outputId, character_image: current.target.outputId},
      controls: {
        prompt: "A fictional woman in a grey tracksuit waves in a plain light-grey studio. Replace her with a realistic fictional man in his sixties with a short grey beard, wearing a navy blue work jacket. Keep the studio, the light and the motion.",
        person: "0", seed: 73,
      },
    }, "character-replace-short.mp4");
    writeState({replaceShort: record});
  }

  if (stages.includes("replaceLong")) {
    const scail = capability("scail2-character-replace");
    const clip = join(ROOT, "long-replace-source.mp4");
    const face = join(process.cwd(), "fixtures", "real", "portrait-man-front.jpg");
    if (!existsSync(clip)) throw new Error("long-replace-source.mp4 is missing (121 frames, 24 fps): copy a cleared QA clip into .comfyfield/qa/transform/");
    if (!existsSync(face)) throw new Error("fixtures/real/portrait-man-front.jpg is missing");
    let current = readState();
    if (!current.longReplaceSource) {
      current = writeState({longReplaceSource: {assetId: (await upload(base, project, clip)).id}});
    }
    if (!current.longReplaceFace) {
      current = writeState({longReplaceFace: {assetId: (await upload(base, project, face, "image/jpeg")).id}});
    }
    // The panel's own preflight call: it names the passes before the run is queued.
    const clipCheck = await call("GET", `${base}/replace-clip-check?assetId=${current.longReplaceSource.assetId}`);
    console.log(`\nclip check ${JSON.stringify(clipCheck)}`);
    if (clipCheck.chunks !== 2) throw new Error(`expected 2 chunks for the 121-frame clip, got ${clipCheck.chunks}`);
    writeState({longReplaceClipCheck: clipCheck});
    const started = Date.now();
    const record = await runAndWait(base, worker.id, project, scail, {
      inputs: {source_video: current.longReplaceSource.assetId, character_image: current.longReplaceFace.assetId},
      controls: {
        prompt: "Close-up portrait of a young Black man with short purple locs wearing a plain beige t-shirt, standing against a plain dark grey studio background. He looks at the camera and moves naturally; keep the same framing, background and soft light.",
        person: "0", seed: 74,
      },
    }, "character-replace-long.mp4");
    writeState({replaceLong: {...record, clipCheck, wallSeconds: Math.round((Date.now() - started) / 1000)}});
  }

  if (stages.includes("motionElement")) {
    const elementId = process.env.COMFYFIELD_TEST_ELEMENT_ID;
    const elementAssetId = process.env.COMFYFIELD_TEST_ELEMENT_ASSET_ID;
    if (!elementId || !elementAssetId) throw new Error("Set COMFYFIELD_TEST_ELEMENT_ID and COMFYFIELD_TEST_ELEMENT_ASSET_ID for motionElement");
    const animate = capability("wan-animate2-distilled");
    const clip = join(ROOT, "driving-performance.mp4");
    if (!existsSync(clip)) throw new Error("run the generate stage first: driving-performance.mp4 is missing");
    let current = writeState({});
    if (!current.characterProjectClip) {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(clip)], {type: "video/mp4"}), "driving-performance.mp4");
      const asset = await call("POST", `${base}/assets?projectId=${exportProject}`, undefined, form);
      current = writeState({characterProjectClip: {assetId: asset.id}});
    }
    // Bind a character element and asset in the selected project.
    const record = await runAndWait(base, worker.id, exportProject, animate, {
      inputs: {motion_video: current.characterProjectClip.assetId},
      elementInputs: {start_image: {elementId, assetId: elementAssetId}},
      controls: {
        prompt: "A realistic fictional woman in her thirties with short dark hair, a forest green jacket, grey trousers and simple boots, plain grey studio background.",
        motion_prompt: "She waves with her right hand, shifts her weight and turns her head slightly.",
        width: 482, height: 854, seed: 61,
      },
    }, "motion-element.mp4");
    let provenance = null;
    try { provenance = await call("GET", `${base}/runs/${record.runId}/provenance`); } catch { /* recorded as null below */ }
    writeState({motionElement: {...record, elementId, elementAssetId, provenanceWorkflowHash: provenance?.workflowHash ?? null}});
  }

  if (stages.includes("swapMultiRegion")) {
    const current = readState();
    if (!current.trackSource) throw new Error("run swapTracked first: the envelope clip is missing");
    const segment = capability("sam31-video-point-mask");
    const edit = capability("wan21-vace-masked-edit");
    let mask = current.multiMask;
    if (!mask) {
      mask = await runAndWait(base, worker.id, project, segment, {
        inputs: {source_video: current.trackSource.assetId},
        tracking: {frameIndex: 0, objectIndex: 1, points: [
          {x: 240, y: 330, kind: "include"},
          {x: 220, y: 480, kind: "include"},
          {x: 190, y: 735, kind: "include"},
          {x: 300, y: 735, kind: "include"},
        ]},
        controls: {},
      }, "tracked-multi-mask.mp4");
      writeState({multiMask: mask});
    }
    await call("POST", `${base}/assets/${mask.outputId}/mask-review`, {decision: "approve", expectedSha256: mask.sha256});
    const record = await runAndWait(base, worker.id, project, edit, {
      inputs: {source_video: current.trackSource.assetId, edit_mask: mask.outputId},
      controls: {
        prompt: "A forest-green velvet tracksuit and black leather heeled boots, keeping the pose, floor and studio lighting.",
        seed: 95, strength: 1,
      },
    }, "object-swap-multi.mp4");
    writeState({swapMulti: record});
  }

  if (stages.includes("swapChain")) {
    const segment = capability("sam31-video-mask");
    const edit = capability("wan21-vace-masked-edit");
    // The one-click card's chain, twice: find the thing with SAM 3.1, approve that
    // mask through the review endpoint, then change the thing with VACE. Both clips
    // are already inside the mask envelope (16 fps, 33 frames, at most 832 px a
    // side); this script never spawns a process, so they are prepared with ffmpeg
    // outside it, and TRANSFORM-EVIDENCE.md records the command.
    const clips = [
      {key: "chainRedDress", file: "swap-clip-red-dress-16fps.mp4", prompt: "the red dress",
        change: "A navy blue pinstripe business suit with a white shirt, keeping her pose, the dark studio background and the warm side light."},
      {key: "chainLoft", file: "swap-clip-loft-16fps.mp4", prompt: "the windows",
        change: "Tall windows looking out on a snowy pine forest at dusk, keeping the white wall, the concrete floor and her pose."},
    ];
    for (const clip of clips) {
      let current = readState();
      if (!current[`${clip.key}Source`]) {
        const file = join(ROOT, clip.file);
        if (!existsSync(file)) throw new Error(`${clip.file} is missing (16 fps, 33 frames, at most 832 px a side)`);
        current = writeState({[`${clip.key}Source`]: {assetId: (await upload(base, project, file)).id}});
      }
      const source = current[`${clip.key}Source`];
      let mask = current[`${clip.key}Mask`];
      if (!mask) {
        mask = await runAndWait(base, worker.id, project, segment, {
          inputs: {source_video: source.assetId}, controls: {}, tracking: {prompt: clip.prompt},
        }, `${clip.key}-mask.mp4`);
        writeState({[`${clip.key}Mask`]: mask});
      }
      const maskAsset = await call("GET", `${base}/assets/${mask.outputId}`);
      // The same endpoint and body the review panel posts to (SwapMaskReview, "Use this mask").
      const review = await call("POST", `${base}/assets/${mask.outputId}/mask-review`, {decision: "approve", expectedSha256: mask.sha256});
      writeState({[`${clip.key}Review`]: {maskAssetId: mask.outputId, prompt: clip.prompt, review, maskCoverage: maskAsset.metadata?.maskCoverage ?? null}});
      const started = Date.now();
      const record = await runAndWait(base, worker.id, project, edit, {
        inputs: {source_video: source.assetId, edit_mask: mask.outputId},
        controls: {prompt: clip.change},
      }, `${clip.key}-edit.mp4`);
      writeState({[`${clip.key}Edit`]: {...record, changePrompt: clip.change, wallSeconds: Math.round((Date.now() - started) / 1000)}});
    }
  }

  if (stages.includes("swapTrackedPoints")) {
    const current = readState();
    if (!current.trackSource) throw new Error("run swapTracked first: the envelope clip is missing");
    const segment = capability("sam31-video-point-mask");
    const edit = capability("wan21-vace-masked-edit");
    let mask = current.shoePointMask;
    if (!mask) {
      mask = await runAndWait(base, worker.id, project, segment, {
        inputs: {source_video: current.trackSource.assetId},
        tracking: {frameIndex: 0, objectIndex: 1, points: [
          {x: 190, y: 735, kind: "include"},
          {x: 300, y: 735, kind: "include"},
        ]},
        controls: {},
      }, "tracked-shoe-points.mp4");
      writeState({shoePointMask: mask});
    }
    await call("POST", `${base}/assets/${mask.outputId}/mask-review`, {decision: "approve", expectedSha256: mask.sha256});
    const record = await runAndWait(base, worker.id, project, edit, {
      inputs: {source_video: current.trackSource.assetId, edit_mask: mask.outputId},
      controls: {
        prompt: "Black leather lace-up boots with a low heel, keeping the pose, floor and studio lighting unchanged.",
        seed: 94, strength: 1,
      },
    }, "object-swap-shoes-points.mp4");
    writeState({swapShoesPoints: record});
  }

  if (stages.includes("restyleLoft")) {
    const current = readState();
    if (!current.motionD) throw new Error("run motionMatrix first: the landscape motion clip is missing");
    const canny = capability("vace-canny-restyle");
    const record = await runAndWait(base, worker.id, project, canny, {
      inputs: {source_video: current.motionD.outputId},
      controls: {prompt: "", seed: 43, strength: 1},
      presetId: "golden-hour",
    }, "restyle-golden-loft.mp4");
    writeState({restyleLoft: record});
  }

  if (stages.includes("swapTrackedShoes2")) {
    const current = readState();
    if (!current.trackSource) throw new Error("run swapTracked first: the envelope clip is missing");
    const segment = capability("sam31-video-mask");
    const edit = capability("wan21-vace-masked-edit");
    let mask = current.shoeMask2;
    if (!mask) {
      mask = await runAndWait(base, worker.id, project, segment, {
        inputs: {source_video: current.trackSource.assetId},
        tracking: {prompt: "the shoes"},
        controls: {threshold: 0.3},
      }, "tracked-shoe2-mask.mp4");
      writeState({shoeMask2: mask});
    }
    await call("POST", `${base}/assets/${mask.outputId}/mask-review`, {decision: "approve", expectedSha256: mask.sha256});
    const record = await runAndWait(base, worker.id, project, edit, {
      inputs: {source_video: current.trackSource.assetId, edit_mask: mask.outputId},
      controls: {
        prompt: "Black leather lace-up boots with a low heel, keeping the pose, floor and studio lighting unchanged.",
        seed: 93, strength: 1,
      },
    }, "object-swap-shoes2.mp4");
    writeState({swapShoes2: record});
  }

  if (stages.includes("swapTrackedShoes")) {
    const current = readState();
    if (!current.trackSource) throw new Error("run swapTracked first: the envelope clip is missing");
    const segment = capability("sam31-video-mask");
    const edit = capability("wan21-vace-masked-edit");
    let mask = current.shoeMask;
    if (!mask) {
      mask = await runAndWait(base, worker.id, project, segment, {
        inputs: {source_video: current.trackSource.assetId},
        tracking: {prompt: "the white trainers"},
        controls: {threshold: 0.35},
      }, "tracked-shoe-mask.mp4");
      writeState({shoeMask: mask});
    }
    await call("POST", `${base}/assets/${mask.outputId}/mask-review`, {decision: "approve", expectedSha256: mask.sha256});
    const record = await runAndWait(base, worker.id, project, edit, {
      inputs: {source_video: current.trackSource.assetId, edit_mask: mask.outputId},
      controls: {
        prompt: "Black leather lace-up boots with a low heel, keeping the pose, floor and studio lighting unchanged.",
        seed: 92, strength: 1,
      },
    }, "object-swap-shoes.mp4");
    writeState({swapShoes: record});
  }

  if (stages.includes("swapTracked")) {
    let current = readState();
    if (!current.driving) throw new Error("run the generate stage first");
    const segment = capability("sam31-video-mask");
    const edit = capability("wan21-vace-masked-edit");
    if (!current.trackSource) {
      const clip = join(ROOT, "swap-track-source.mp4");
      if (!existsSync(clip)) throw new Error("swap-track-source.mp4 is missing (480x832, 16 fps, 33 frames)");
      const form = new FormData();
      form.append("file", new Blob([readFileSync(clip)], {type: "video/mp4"}), "swap-track-source.mp4");
      const asset = await call("POST", `${base}/assets?projectId=${project}`, undefined, form);
      current = writeState({trackSource: {assetId: asset.id}});
    }
    // A fresh text-prompted SAM 3.1 track inside the VACE envelope, not a reused mask.
    let mask = current.swapTrackMask;
    if (!mask) {
      mask = await runAndWait(base, worker.id, project, segment, {
        inputs: {source_video: current.trackSource.assetId},
        tracking: {prompt: "the grey tracksuit"},
        controls: {threshold: 0.35},
      }, "tracked-mask.mp4");
      writeState({swapTrackMask: mask});
    }
    // Generated masks are admissible only after an explicit review decision.
    await call("POST", `${base}/assets/${mask.outputId}/mask-review`, {decision: "approve", expectedSha256: mask.sha256});
    const record = await runAndWait(base, worker.id, project, edit, {
      inputs: {source_video: current.trackSource.assetId, edit_mask: mask.outputId},
      controls: {
        prompt: "A deep forest-green velvet tracksuit with a silver zipper, keeping the original fabric folds and studio lighting.",
        seed: 91, strength: 1,
      },
    }, "object-swap-tracked.mp4");
    writeState({swapTracked: record});
  }

  if (stages.includes("replaceChain")) {
    const current = readState();
    if (!current.twoPersonClip || !current.target) throw new Error("run generate and scail first");
    const prompt = "Replace the person on the left in @Video 1 with the face from @Image 1, dress them in a navy work jacket. Two people are talking in a plain grey studio; keep the woman on the right and the grey background.";
    const answer = await call("POST", `${base}/reference-plan`, {prompt});
    console.log(`\nplanner ${answer.source}: ${JSON.stringify(answer.plan)}`);
    if (!answer.plan || answer.problems.length) throw new Error(`planner rejected the request: ${answer.problems.join(" ")}`);
    const person = answer.plan.people[0];
    // Mirrors buildReplaceSteps: the request's scene words (without @ references) plus a
    // composition clause, so SCAIL keeps the full frame instead of cropping to the character.
    const scene = prompt.replace(/@\s*(image|img|video|vid)\s*\d{1,2}\b/gi, " ").replace(/\s+/g, " ").trim();
    const replacementPrompt = [
      person.outfit && `The ${person.target} wears ${person.outfit}.`,
      scene,
      "Keep the source video's full frame, camera, background, other people and motion.",
      answer.plan.keep && `Keep ${answer.plan.keep.replace(/^keep\s+/i, "")}.`,
    ].filter(Boolean).join(" ");
    const media = {"@Video 1": current.twoPersonClip.assetId, "@Image 1": current.target.outputId};
    let character = media[person.face];
    if (!character) throw new Error(`no media for ${person.face}`);
    const edit = capability("flux2-klein-edit");
    if (person.outfit || person.faceEdit) {
      const prep = await runAndWait(base, worker.id, project, edit, {
        inputs: {source_image: character},
        controls: {
          prompt: ["Full-body photo of the same person, same identity and skin tone, standing, plain light background.",
            person.faceEdit && `Face: ${person.faceEdit}; keep it recognizably the same person.`,
            person.outfit && `Wearing ${person.outfit}.`].filter(Boolean).join(" "),
          steps: 4, megapixels: 1, seed: 81,
        },
      }, "replace-prep.png");
      writeState({replacePrep: prep});
      character = prep.outputId;
    }
    const scail = capability("scail2-character-replace");
    const index = /\bright\b/i.test(person.target) ? answer.plan.people.length - 1 : 0;
    const final = await runAndWait(base, worker.id, project, scail, {
      inputs: {source_video: media[answer.plan.video], character_image: character},
      controls: {
        person: String(index),
        prompt: replacementPrompt,
        seed: 82,
      },
    }, "replace-chain.mp4");
    writeState({replaceChain: {...final, planner: answer.source, plan: answer.plan}});
  }

  if (stages.includes("motionMatrix")) {
    const still = capability("flux2-klein-t2i"), animate = capability("wan-animate2-distilled");
    let current = readState();
    if (!current.driving) throw new Error("run the generate stage first: the driving clip is missing");
    if (!current.fixtureC) {
      current = writeState({fixtureC: await runAndWait(base, worker.id, project, still, {
        controls: {
          prompt: "Full-body studio photograph of a fictional woman in her twenties with long auburn hair, wearing a red dress and black boots, warm side lighting, dark neutral studio background, standing facing the camera, natural proportions.",
          width: 704, height: 1280, seed: 16, steps: 20,
        },
      }, "character-red-dress.png")});
    }
    if (!current.fixtureD) {
      current = writeState({fixtureD: await runAndWait(base, worker.id, project, still, {
        controls: {
          prompt: "Wide studio photograph of a fictional woman in her forties with a blonde bob, wearing a white blouse and dark trousers, full body visible, standing in a bright loft with a large window and cool daylight, natural proportions.",
          width: 1280, height: 704, seed: 17, steps: 20,
        },
      }, "character-loft-wide.png")});
    }
    if (!current.motionC) {
      current = writeState({motionC: await runAndWait(base, worker.id, project, animate, {
        inputs: {start_image: current.fixtureC.outputId, motion_video: current.driving.outputId},
        controls: {
          prompt: "A realistic fictional woman in her twenties with long auburn hair, a red dress and black boots, dark studio background with warm side light.",
          motion_prompt: "She waves with her right hand, shifts her weight and turns her head slightly.",
          width: 482, height: 854, seed: 22,
        },
      }, "motion-red-dress.mp4")});
    }
    if (!current.motionD) {
      writeState({motionD: await runAndWait(base, worker.id, project, animate, {
        inputs: {start_image: current.fixtureD.outputId, motion_video: current.driving.outputId},
        controls: {
          prompt: "A realistic fictional woman in her forties with a blonde bob, a white blouse and dark trousers, standing in a bright loft with a large window and cool daylight.",
          motion_prompt: "She waves with her right hand, shifts her weight and turns her head slightly.",
          width: 854, height: 482, seed: 23,
        },
      }, "motion-loft-wide.mp4")});
    }
  }

  if (stages.includes("swap")) {
    const sourceVideo = process.env.COMFYFIELD_TEST_SOURCE_VIDEO_ID, editMask = process.env.COMFYFIELD_TEST_EDIT_MASK_ID;
    if (!sourceVideo || !editMask) throw new Error("Set COMFYFIELD_TEST_SOURCE_VIDEO_ID and COMFYFIELD_TEST_EDIT_MASK_ID for swap");
    const edit = capability("wan21-vace-masked-edit");
    const referenceEdit = capability("wan21-vace-masked-edit-reference");
    const still = capability("flux2-klein-t2i");
    let current = readState();
    if (!current.product) {
      current = writeState({product: await runAndWait(base, worker.id, exportProject, still, {
        controls: {
          prompt: "Product photograph of a deep purple velvet bomber jacket with a polished silver zipper, front view on a plain white background, even studio light, no people.",
          width: 1024, height: 1024, seed: 15, steps: 20,
        },
      }, "object-reference.png")});
    }
    const record = await runAndWait(base, worker.id, exportProject, edit, {
      inputs: {source_video: sourceVideo, edit_mask: editMask},
      controls: {
        prompt: "A deep purple velvet bomber jacket with a polished silver zipper, studio product lighting, fabric folds matching the original garment.",
        seed: 31, strength: 1,
      },
    }, "object-swap.mp4");
    const withReference = await runAndWait(base, worker.id, exportProject, referenceEdit, {
      inputs: {source_video: sourceVideo, edit_mask: editMask, object_reference: current.product.outputId},
      controls: {
        prompt: "Replace the jacket with the reference garment, keep the original pose, folds and studio lighting.",
        seed: 32, strength: 1,
      },
    }, "object-swap-reference.mp4");
    writeState({swap: record, swapReference: withReference});
  }

  if (stages.includes("restyle")) {
    const current = readState();
    if (!current.driving || !current.style) throw new Error("run the generate stage first");
    const canny = capability("vace-canny-restyle");
    const reference = capability("vace-reference-restyle");
    const noir = await runAndWait(base, worker.id, project, canny, {
      inputs: {source_video: current.driving.outputId},
      controls: {prompt: "", seed: 41, strength: 1},
      presetId: "noir",
    }, "restyle-noir.mp4");
    const styled = await runAndWait(base, worker.id, project, reference, {
      inputs: {source_video: current.driving.outputId, style_reference: current.style.outputId},
      controls: {
        prompt: "Repaint the studio and the woman in the muted watercolor style of the reference, keep her motion, framing and timing.",
        seed: 42, strength: 1,
      },
    }, "restyle-reference.mp4");
    writeState({restylePreset: noir, restyleReference: styled});
  }

  if (stages.includes("restyleRef")) {
    const current = readState();
    if (!current.driving || !current.style) throw new Error("run the generate stage first");
    const reference = capability("vace-reference-restyle");
    const styled = await runAndWait(base, worker.id, project, reference, {
      inputs: {source_video: current.driving.outputId, style_reference: current.style.outputId},
      controls: {
        prompt: "Repaint the studio and the woman in the muted watercolor style of the reference, keep her motion, framing and timing.",
        seed: 42, strength: 1,
      },
    }, "restyle-reference-trimmed.mp4");
    writeState({restyleReferenceTrimmed: styled});
  }

  if (stages.includes("restyleRefFit")) {
    const current = readState();
    if (!current.driving || !current.style) throw new Error("run the generate stage first");
    // 0.3.0 fits the source to Wan VACE before Canny and before the width, height
    // and length inputs. The 0.2.0 line recorded no run on this graph; this is it,
    // with the same clip, reference, prompt, seed and strength as that run.
    const reference = capability("vace-reference-restyle");
    const styled = await runAndWait(base, worker.id, project, reference, {
      inputs: {source_video: current.driving.outputId, style_reference: current.style.outputId},
      controls: {
        prompt: "Repaint the studio and the woman in the muted watercolor style of the reference, keep her motion, framing and timing.",
        seed: 42, strength: 1,
      },
    }, "restyle-reference-030.mp4");
    writeState({restyleReference030: styled});
  }

  if (stages.includes("restyleLooks")) {
    const current = readState();
    const canny = capability("vace-canny-restyle");
    // Three cleared clips, three different people, light and framing: a neutral
    // studio portrait, a warm side-lit dark studio and a cool daylight 16:9 loft.
    const clips = [
      {key: "studio", label: "studio portrait", source: current.driving},
      {key: "redDress", label: "red dress, warm side light", source: current.motionC},
      {key: "loft", label: "loft wide, cool daylight", source: current.motionD},
    ];
    for (const clip of clips) {
      if (!clip.source) throw new Error(`the ${clip.label} clip is missing: run the earlier stages first`);
      for (const [look, seed] of [["noir", 41], ["golden-hour", 43]]) {
        const record = await runAndWait(base, worker.id, project, canny, {
          inputs: {source_video: clip.source.outputId},
          controls: {prompt: "", seed, strength: 1},
          presetId: look,
        }, `looks-${look}-${clip.key}.mp4`);
        writeState({[`look-${look}-${clip.key}`]: record});
      }
    }
  }

  if (stages.includes("vfx")) {
    const upscale = capability("nvidia-vfx-upscale");
    // A cleared Pexels clip with the showcase's generated 440 Hz tone: 540x960,
    // 25 fps, 2 s, with audio. docs/NVIDIA-VFX.md records the ffmpeg command
    // that made it; this script never spawns a process.
    const clip = join(ROOT, "vfx-source.mp4");
    if (!existsSync(clip)) throw new Error("vfx-source.mp4 is missing (540x960, 25 fps, 2 s, with audio): see the GPU run section of docs/NVIDIA-VFX.md");
    let current = readState();
    if (!current.vfxSource) current = writeState({vfxSource: {assetId: (await upload(base, project, clip)).id}});
    // The app already decodes a project clip for trim planning, so that plan is
    // where the input facts come from: size, rate, frames, duration and audio.
    const plan = await call("POST", `${base}/video-extension-plans`, {
      projectId: project, sourceAssetId: current.vfxSource.assetId,
      startFrame: 0, endFrameExclusive: 1, extensionFrames: 0, overlapFrames: 0, audioPolicy: "preserve",
    });
    const source = {
      width: plan.source.width, height: plan.source.height,
      fps: `${plan.source.frameRate.numerator}/${plan.source.frameRate.denominator}`,
      frames: plan.source.frameCount, seconds: plan.source.durationSeconds, hasAudio: plan.source.hasAudio,
    };
    const started = Date.now();
    const record = await runAndWait(base, worker.id, project, upscale, {
      inputs: {source_video: current.vfxSource.assetId},
      controls: {scale: 2, mode: "ULTRA"},
      audioPolicy: "preserve",
    }, "vfx-upscale-2x.mp4");
    const wallSeconds = Math.round((Date.now() - started) / 1000);
    const out = (await call("GET", `${base}/assets/${record.outputId}`)).metadata;
    writeState({vfx: {...record, source, wallSeconds, audioKept: out?.hasAudio, outputFps: out?.frameRate, outputSeconds: out?.durationSeconds}});
    console.log(`\nvfx source ${JSON.stringify(source)}`);
    console.log(`vfx output ${JSON.stringify({...record.media, audioKept: out?.hasAudio})} in ${wallSeconds}s`);
  }

  const final = readState();
  console.log(`\nstate: ${STATE_FILE}`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(final).map(([key, value]) => [key, value?.runId ?? value])), null, 2));
}

main().catch(error => {
  console.error(`\ntransform evidence failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
