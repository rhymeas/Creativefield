// Export the exact bytes listed in the manually reviewed release manifest.
// Usage: node scripts/public-export.mjs <existing-empty-output-directory>
// This is a staging copy, not permission to publish. The review manifest is
// private and must be created through the project's manual review process.
import {lstat, mkdir, readdir, realpath, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {readReviewedRelease} from "./release-privacy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target || process.argv.length !== 3) throw new Error("Usage: node scripts/public-export.mjs <existing-empty-output-directory>");

// Check the complete reviewed file list and retain the verified bytes before
// touching the output directory. Never generate or approve a review manifest.
const files = await readReviewedRelease(root);
const output = resolve(target);
const info = await lstat(output);
if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Output must be an existing, unlinked directory.");
const rootReal = await realpath(root);
const outputReal = await realpath(output);
const insideRoot = relative(rootReal, outputReal);
if (!insideRoot || (!insideRoot.startsWith(`..${sep}`) && insideRoot !== ".." && !isAbsolute(insideRoot))) {
  throw new Error("Output must be outside the source repository.");
}
if ((await readdir(outputReal)).length) throw new Error("Output directory must be empty.");

for (const file of files) {
  const destination = join(outputReal, ...file.path.split("/"));
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, file.content, {flag: "wx"});
}
console.log(`Exported ${files.length} reviewed files without Git history. Review the staged tree before publication.`);
