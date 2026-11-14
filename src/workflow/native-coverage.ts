/** Native template IDs which the loaded catalogue cannot validate. */
export function missingNativeTemplates(nativeIds:string[],catalogueIds:Iterable<string>,filter?:string):string[] {
  const available=new Set(catalogueIds);
  return [...new Set(nativeIds)].filter(id=>(!filter||id===filter)&&!available.has(id));
}

export type NativeTemplateRecord = {folder:string;id?:unknown;error?:string};

/** A template is not covered if it cannot be identified uniquely in the catalogue. */
export function nativeTemplateIssues(records:NativeTemplateRecord[], filter?:string):Array<{id:string;reason:string}> {
  const issues:Array<{id:string;reason:string}>=[];
  const firstById=new Map<string,string>();
  for(const record of records){
    if(typeof record.id!=="string" || !record.id.trim()){
      if(!filter || filter===record.folder)issues.push({id:record.folder,reason:record.error??"native template has no valid manifest id"});
      continue;
    }
    const first=firstById.get(record.id);
    if(first){
      if(!filter || filter===record.id)issues.push({id:record.id,reason:`duplicate native template id in ${first} and ${record.folder}`});
    }else firstById.set(record.id,record.folder);
  }
  return issues;
}
