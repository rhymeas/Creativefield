import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, test} from "vitest";

/* The README and docs tell a stranger how to run this. A renamed npm script or a
   moved scripts/ file turns those steps into instructions that cannot work, and the
   page still looks fine. These cases read every document and check the names. */
const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = new Set(Object.keys((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {scripts?: Record<string, string>}).scripts ?? {}));
const documents = ["README.md", ...readdirSync(join(root, "docs"), {recursive: true, encoding: "utf8"})
  .filter((file) => file.endsWith(".md"))
  .map((file) => `docs/${file.split("\\").join("/")}`)];

/** "npm run x" needs script x; so do the npm shorthands for start, stop, restart and test. */
const runScript = /\bnpm run ([a-z][\w:.-]*)/g;
const shorthand = /\bnpm (start|stop|restart|test)\b/g;
/** A documented scripts/ path with a file extension must exist, or the command will not run. */
const scriptFile = /scripts[/\\][\w./\\-]*\.(?:mjs|cjs|ts|tsx|js|bat|sh|py|json)/g;

function missingNames(pattern: RegExp, known: (name: string) => boolean, describeName: (name: string) => string): string[] {
  const missing: string[] = [];
  for (const document of documents) {
    const path = join(root, document);
    if (!existsSync(path)) { missing.push(`${document}: does not exist`); continue; }
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      for (const match of line.matchAll(pattern)) {
        const name = match[1] ?? match[0];
        if (!known(name)) missing.push(`${document}:${index + 1}: ${describeName(name)}`);
      }
    }
  }
  return [...new Set(missing)];
}

describe("setup steps in the README and docs", () => {
  test("every npm run script they name exists in package.json", () => {
    expect(documents).toContain("README.md");
    expect(documents.length).toBeGreaterThan(1);
    expect(scripts.size).toBeGreaterThan(20);
    expect(missingNames(runScript, (name) => scripts.has(name), (name) => `npm run ${name} is not a script`)).toEqual([]);
    expect(missingNames(shorthand, (name) => scripts.has(name), (name) => `npm ${name} is not a script`)).toEqual([]);
  });

  test("every scripts/ file they name exists", () => {
    const file = (name: string) => join(root, name.split("\\").join("/"));
    expect(missingNames(scriptFile, (name) => existsSync(file(name)), (name) => `${name} does not exist`)).toEqual([]);
  });
});
