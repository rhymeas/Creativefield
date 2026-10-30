// How much of the app builds its own controls and looks instead of using the design system (src/ds).
// `node scripts/ds-audit.mjs` prints a table; test/ds-bypass.test.ts imports `auditDesignSystem` and fails on any new bypass.
import {readdirSync,readFileSync,statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const RAW=/<(button|input|select|textarea)\b/g;
const INLINE_STYLE=/style=\{\{/g;
/* Feature CSS is layout only (flex, grid, gap, sizing, overflow). These properties, with a real value, are the design system's.
   A reset such as `border:0` is layout housekeeping, not a look. */
const LOOK=/(^|[;{\s])(color|background(-color|-image)?|border(-color|-radius)?|font-(size|weight|family)|box-shadow|text-shadow|opacity)\s*:(?!\s*(0|none|inherit|initial)\b)/gm;

const stripCode=(text)=>text.replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"").replace(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g,'""');
const stripCss=(text)=>text.replace(/\/\*[\s\S]*?\*\//g,"");

/** Everything outside src/ds, per file: raw controls, inline styles, and look properties in feature CSS. */
export function auditDesignSystem(root="src"){
  const walk=(dir)=>readdirSync(dir).flatMap(name=>{
    const full=path.join(dir,name);
    if(statSync(full).isDirectory())return dir===root&&name==="ds"?[]:walk(full);
    return [full.replaceAll("\\","/")];
  });
  const rows={};
  for(const file of walk(root)){
    const text=readFileSync(file,"utf8");
    if(/\.tsx?$/.test(file)){
      const code=file.endsWith(".tsx")?stripCode(text):"";
      const raw=(code.match(RAW)??[]).length,inline=(text.replace(/\/\*[\s\S]*?\*\//g,"").match(INLINE_STYLE)??[]).length;
      if(raw||inline)rows[file]={raw,inline,look:0};
    }else if(file.endsWith(".css")){
      const look=(stripCss(text).match(LOOK)??[]).length;
      if(look)rows[file]={raw:0,inline:0,look};
    }
  }
  return rows;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const rows=auditDesignSystem(),list=Object.entries(rows),sum=key=>list.reduce((total,[,row])=>total+row[key],0);
  console.log(`Outside src/ds: ${sum("raw")} raw controls, ${sum("inline")} inline styles, ${sum("look")} look properties in feature CSS.`);
  for(const [file,row] of list.sort((a,b)=>(b[1].raw+b[1].inline+b[1].look)-(a[1].raw+a[1].inline+a[1].look)))console.log(`  ${file.padEnd(52)} raw ${String(row.raw).padStart(3)}  inline ${String(row.inline).padStart(3)}  look ${String(row.look).padStart(3)}`);
}
