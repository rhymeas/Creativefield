import {createHash} from "node:crypto";
import {lstatSync,readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";

/** Stable content hash for a copied custom-node directory, excluding Python caches. */
export function nativeNodeTreeHash(root:string):string {
  const hash=createHash("sha256");
  let bytes=0,entries=0;
  function visit(directory:string,relative:string){
    for(const name of readdirSync(directory).sort()){
      if(name===".git"||name==="__pycache__"||name.endsWith(".pyc"))continue;
      if(++entries>10000)throw new Error("node directory has too many entries to pin");
      const path=join(directory,name),key=relative?`${relative}/${name}`:name,info=lstatSync(path);
      if(info.isSymbolicLink())throw new Error(`node directory contains a symbolic link: ${key}`);
      if(info.isDirectory()){hash.update(`D\0${key}\0`);visit(path,key);continue;}
      if(!info.isFile())throw new Error(`node directory contains an unsupported entry: ${key}`);
      bytes+=info.size;
      if(bytes>128*1024*1024)throw new Error("node directory exceeds the 128 MB pinning limit");
      hash.update(`F\0${key}\0${info.size}\0`);hash.update(readFileSync(path));
    }
  }
  visit(root,"");
  return hash.digest("hex");
}
