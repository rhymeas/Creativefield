import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";
import {readReviewedRelease} from "./release-privacy.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
// Refuse before creating/deleting output or loading an unreviewed source tree.
const reviewedFiles=await readReviewedRelease(root);
const outputRoot=join(root,"release");
const packageJson=JSON.parse(await readFile(join(root,"package.json"),"utf8"));
const stamp=new Date().toISOString().replace(/[-:]/g,"").replace(/\..+/,"").replace("T","-");
const name=`comfyfield-${packageJson.version}-${stamp}`;
const archive=join(outputRoot,`${name}.tar.gz`);
const prefix=`${name}/`;

const required=["LICENSE","README.md","package.json","package-lock.json","docs/LICENSE-INVENTORY.md","docs/INSTALL-BACKUP-RECOVERY.md","native-workflows"];
const files=reviewedFiles.map(file=>file.path);
for(const file of required)if(!files.some(candidate=>candidate===file||candidate.startsWith(`${file}/`)))throw new Error(`Release is missing required path: ${file}`);

function field(value,length,offset,buffer){
  const bytes=Buffer.from(value,"utf8");
  if(bytes.length>length)throw new Error(`Tar field is too long: ${value}`);
  bytes.copy(buffer,offset);
}
function octal(value,length){
  return value.toString(8).padStart(length-1,"0")+"\0";
}
function header(file,size,mtime){
  const buffer=Buffer.alloc(512);
  let name=file,prefix="";
  if(Buffer.byteLength(name)>100){
    const parts=file.split("/");
    while(parts.length>1&&Buffer.byteLength(parts.join("/"))>100)prefix=parts.shift()+"/"+prefix;
    name=parts.join("/");
    prefix=prefix.replace(/\/$/,"");
    if(prefix.length>155||name.length>100)throw new Error(`Path is too long for ustar: ${file}`);
  }
  field(name,100,0,buffer);
  field(octal(0o644,8),8,100,buffer);
  field(octal(0,8),8,108,buffer);
  field(octal(0,8),8,116,buffer);
  field(octal(size,12),12,124,buffer);
  field(octal(mtime,12),12,136,buffer);
  field("        ",8,148,buffer);
  field("0",1,156,buffer);
  field("ustar\0",6,257,buffer);
  field("00",2,263,buffer);
  field("root",32,265,buffer);
  field("root",32,297,buffer);
  field(prefix,155,345,buffer);
  let checksum=0;
  for(const byte of buffer)checksum+=byte;
  field(octal(checksum,8),8,148,buffer);
  return buffer;
}

await mkdir(outputRoot,{recursive:true});
const chunks=[],mtime=Math.floor(Date.now()/1000),seen=new Set();
for(const {path:file,content} of reviewedFiles){
  if(seen.has(file))continue;
  seen.add(file);
  chunks.push(header(prefix+file,content.length,mtime),content,Buffer.alloc((512-content.length%512)%512));
}
chunks.push(Buffer.alloc(1024));
const bytes=gzipSync(Buffer.concat(chunks),{level:9});
await writeFile(archive,bytes,{flag:"wx"});
const sha256=createHash("sha256").update(bytes).digest("hex");
await writeFile(`${archive}.sha256`,`${sha256}  ${name}.tar.gz\n`,{flag:"wx"});
console.log(`release: ${archive}`);
console.log(`files: ${seen.size}`);
console.log(`bytes: ${bytes.length}`);
console.log(`sha256: ${sha256}`);
