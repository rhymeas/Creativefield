import {z} from "zod";
import {BLENDS,GROUP_DEPTH_LIMIT,type Doc} from "./doc";

const ref=z.string().regex(/^asset:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),n=z.number().finite();
const layer=z.object({
  id:z.string().min(1).max(128),name:z.string().max(240),kind:z.enum(["image","paint","adjust"]),src:z.union([ref,z.literal("")]),
  w:n.positive().max(32768),h:n.positive().max(32768),visible:z.boolean(),opacity:n.min(0).max(1),blend:z.enum(BLENDS as [typeof BLENDS[number],...typeof BLENDS[number][]]),
  x:n,y:n,scale:n.positive().max(10000),rotation:n,flipX:z.boolean(),brightness:n,contrast:n,saturation:n,
  locks:z.object({transparent:z.boolean().optional(),paint:z.boolean().optional(),position:z.boolean().optional()}).strict().optional(),
  group:z.string().max(128).optional(),shadow:z.object({dx:n,dy:n,blur:n.min(0).max(10000),color:z.string().max(100)}).strict().optional(),
  linked:z.boolean().optional(),mask:ref.optional(),maskAnchor:z.object({x:n,y:n,scale:n.positive().max(10000),rotation:n,flipX:z.boolean()}).strict().optional(),maskOff:z.boolean().optional(),defringe:z.literal(1).optional(),clip:z.boolean().optional(),
  hue:n.optional(),grayscale:n.optional(),invert:n.optional(),sepia:n.optional(),smartObject:z.unknown().optional(),
}).strict();
const shape=z.object({width:n.int().min(1).max(32768),height:n.int().min(1).max(32768),layers:z.array(layer).max(128),selectedId:z.string().max(128).nullable(),selection:ref.nullable(),
  groups:z.record(z.string().max(128),z.object({name:z.string().max(240),visible:z.boolean(),parent:z.string().max(128).optional(),opacity:n.min(0).max(1).optional(),blend:z.union([z.enum(BLENDS as [typeof BLENDS[number],...typeof BLENDS[number][]]),z.literal("pass-through")]).optional()}).strict()).optional(),
  saved:z.array(z.object({id:z.string().max(128),name:z.string().max(240),key:ref}).strict()).max(128).optional(),
}).strict();
export {DOCUMENT_FORMAT,documentKeys,mapDocumentKeys} from "./document-keys";
/** Shared, bounded parser: stored documents never carry URLs, paths, scripts or inline bitmaps. */
export function validateDocument(value:unknown):Doc{
  let count=0;
  function parse(value:unknown,depth:number):Doc{
    if(depth>8)throw new Error("Smart-object nesting exceeds eight levels.");
    const parsed=shape.parse(value);count+=parsed.layers.length;
    if(count>512||parsed.width*parsed.height>67108864)throw new Error("The document exceeds its editing budget.");
    if(new Set(parsed.layers.map(l=>l.id)).size!==parsed.layers.length)throw new Error("Duplicate layer IDs.");
    for(const [gid,g] of Object.entries(parsed.groups??{})){
      if(g.parent&&!parsed.groups?.[g.parent])throw new Error("A parent layer group is missing.");
      const seen=new Set<string>();let current:string|undefined=gid;
      while(current){if(seen.has(current)||seen.size>=GROUP_DEPTH_LIMIT)throw new Error("Layer groups cannot be cyclic or exceed sixteen levels.");seen.add(current);current=parsed.groups?.[current]?.parent;}
    }
    if(parsed.selectedId&&!parsed.layers.some(l=>l.id===parsed.selectedId))throw new Error("The selected layer is missing.");
    for(const l of parsed.layers){if(l.kind!=="adjust"&&!l.src)throw new Error("A layer bitmap is missing.");if(l.group&&!parsed.groups?.[l.group])throw new Error("A layer group is missing.");if(l.smartObject!==undefined)l.smartObject=parse(l.smartObject,depth+1);}
    return parsed as Doc;
  }
  return parse(value,0);
}
