// Collect the third-party installs and the model files the bundled workflows need.
import fs from "node:fs";
import path from "node:path";

const root = "native-workflows";
const thirdParty = new Map(), models = new Map();
const CORE = /^(Install (a |current |the reviewed |ComfyUI)|Use the (ComfyUI core|installed)|Install ComfyUI 0\.37|Install ComfyUI with native audio)/;
for (const pack of fs.readdirSync(root)) {
  const manifestPath = path.join(root, pack, "manifest.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const route of manifest.routes ?? []) {
    if (route.implementation === "planned") continue;
    for (const requirement of route.requirements ?? []) {
      if (requirement.kind === "node" && requirement.instructions && !CORE.test(requirement.instructions.trim())) {
        thirdParty.set(requirement.instructions.trim(), pack);
      }
      if (requirement.kind === "model") {
        models.set(`${requirement.location}/${requirement.name}`, {location: requirement.location, source: requirement.source ?? "", instructions: requirement.instructions ?? ""});
      }
    }
  }
}

const sortedModels = [...models.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const sortedPacks = [...thirdParty.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const lines = [
  "# Offloading to a rented GPU",
  "",
  "A worker is just an HTTP(S) origin, so a ComfyUI that runs elsewhere can take the heavy work",
  "and the free-RAM gate reads **that** machine. This page lists what the remote box needs,",
  "generated from the bundled workflow manifests — the models and third-party packs are the whole",
  "list, and everything else is core ComfyUI.",
  "",
  "## 1. Point the app at it",
  "",
  "```bash",
  "npm run worker:remote add \"Rented 4090\" https://<pod>-8188.proxy.runpod.net",
  "npm run worker:remote probe <workerId>     # names every capability that is not ready, and why",
  "```",
  "",
  "Then choose that worker in any panel's **Worker** row. Keep the local worker beside it and pick",
  "per run, or `npm run worker:remote point <origin>` to make the remote one the default.",
  "",
  "## 2. Base image",
  "",
  "**ComfyUI 0.37.0** (or another version that provides the same core nodes). Beyond that, only",
  "these third-party pieces are needed:",
  "",
  ...sortedPacks.map(([instructions, pack]) => `- ${instructions}  \n  <sub>needed by \`${pack}\`</sub>`),
  "",
  "A bare ComfyUI will probe as ready for the light capabilities and report `install_required` for",
  "the rest — the probe names the missing piece per capability, so you can install only what you",
  "want to use.",
  "",
  "## 3. Model files, by folder",
  "",
  `**${sortedModels.length}** files, each in the folder named below; the source column comes from the`,
  "manifest where it declares one.",
  "",
  "| File | Folder | Source or note |",
  "| --- | --- | --- |",
  ...sortedModels.map(([file, meta]) => `| \`${file.split("/").slice(1).join("/")}\` | \`${meta.location}\` | ${meta.source ? `<${meta.source}>` : meta.instructions.replace(/\|/g, "/")} |`),
  "",
  "Budget **40–60 GB** of disk for this set plus ComfyUI. A 24 GB GPU with 64 GB RAM matches this",
  "project's tested tier; smaller cards run the light capabilities and refuse the heavy ones.",
  "",
  "## 4. What stays local",
  "",
  "The app, PostgreSQL, the library and all FFmpeg work (trim, storyboard assembly, exports,",
  "marketing renders). Only model execution moves.",
  "",
  "## 5. Checking it worked",
  "",
  "```bash",
  "npm run worker:remote probe <workerId>   # capabilities read 'ready' instead of install_required",
  "npm run worker:remote list               # each worker with its origin and free RAM",
  "npm run worker:remote free               # unload models; refuses while the queue is busy",
  "```",
  "",
].join("\n");

fs.writeFileSync("docs/OFFLOAD-GPU.md", lines, "utf8");
console.log(`wrote docs/OFFLOAD-GPU.md: ${sortedPacks.length} third-party installs, ${sortedModels.length} model files`);
