import {spawnSync} from "node:child_process";
import {mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

// Set the temp root before Vitest starts its compiler/forks, not after collection.
const root=process.env.COMFYFIELD_TEST_TEMP_ROOT ?? join(tmpdir(), "creativefield-tests");
mkdirSync(root,{recursive:true});
// Some integration fixtures create temporary directories inside these namespaces.
// Create their parents before Vitest starts, including on a fresh installation.
for (const name of ["ComfyField", "comfyfield-platform"]) mkdirSync(join(root,name),{recursive:true});
const child=spawnSync(process.execPath,[fileURLToPath(new URL("../node_modules/vitest/vitest.mjs",import.meta.url)),"run",...process.argv.slice(2)],{
  stdio:"inherit",env:{...process.env,TEMP:root,TMP:root,TMPDIR:root,COMFYFIELD_TEST_TEMP_ROOT:root},
});
if(child.error){console.error(child.error.message);process.exit(1);}
process.exit(child.status??1);
