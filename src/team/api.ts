import type {CapabilityManifestV2,WorkerInventory} from "../capabilities/types";
export type User={id:string;email:string;localSingleUser?:boolean};
export type Workspace={id:string;name:string;role:"admin"|"creator"|"viewer"};
export type Project={id:string;name:string;description?:string};
export type Asset={id:string;project_id:string|null;name:string;media_type:string;content_type:string;sha256?:string;bytes:string;created_at:string;parent_id:string|null;metadata?:Record<string,unknown>};
export type AssetPage={items:Asset[];nextCursor:string|null;pendingDeletion?:{id:string;name:string}};
export type ReusableElement={id:string;name:string;kind:"character"|"product"|"environment"|"voice"|"style";description:string;created_at:string;asset_ids:string[];assets:Asset[]};
export type CharacterReference={ordinal:number;assetId:string;assetProjectId:string|null;assetSha256:string;assetMediaType:string;assetContentType:string;assetBytes:number|string;assetMetadata:Record<string,unknown>};
export type CharacterRecord={id:string;projectId:string;elementId:string;name:string;description:string;createdAt:string;usage?:{referenceRuns:number;completedShots:number};referencePack:{version:1;references:CharacterReference[]}};
export type CreatedCharacter=CharacterRecord&{repeated:boolean};
export type Worker={id:string;name:string;enabled:boolean;origin:string;checked_at:string|null;inventory:WorkerInventory|null;can_start?:boolean};
export type Run={id:string;project_id:string;worker_id?:string|null;created_by:string;capability_id:string;capability_version:string;state:string;error:string|null;remote_id?:string|null;transport?:string;output_ids:string[];output_content_type?:string|null;scene?:number|null;shot?:number|null;take?:number|null;created_at:string;updated_at:string;invocation?:{controls:Record<string,unknown>;inputs:Record<string,string>}};
export class ApiError extends Error {constructor(readonly status:number,message:string){super(message);}}
export type RequestOptions={signal?:AbortSignal;timeoutMs?:number};
export async function request<T>(path:string,method="GET",body?:unknown,options:AbortSignal|RequestOptions={}):Promise<T>{
  if(!path.startsWith("/")||path.startsWith("//"))throw new Error("Use a same-origin API path");
  const config:RequestOptions=options instanceof AbortSignal?{signal:options}:options;
  let response:Response;
  try {response=await fetch(`/api/v1${path}`,{method,credentials:"same-origin",headers:body===undefined||body instanceof FormData?undefined:{"Content-Type":"application/json"},body:body instanceof FormData?body:body===undefined?undefined:JSON.stringify(body),signal:config.signal??AbortSignal.timeout(config.timeoutMs??30000)});}
  catch(e){if(config.signal?.aborted)throw e;throw new ApiError(0,"Team server unavailable. No job is submitted to another service.");}
  const content=await response.json().catch(()=>null);
  if(!response.ok)throw new ApiError(response.status,content?.error??`Request failed (${response.status})`);
  return content as T;
}
export const workspacePath=(id:string,tail:string)=>`/workspaces/${encodeURIComponent(id)}/${tail}`;
/** Where AI text runs: ready, needs a key, or needs a Codex sign-in. A key never travels here. */
export type AiTextProviderState="ready"|"needs_key"|"needs_sign_in";
export type AiTextProviderStatus={id:"local-comfy"|"openai-compatible"|"chatgpt";label:string;state:AiTextProviderState;detail:string};
export type AiTextSettings={providers:AiTextProviderStatus[];active?:AiTextProviderStatus["id"]};
export const loadAiText=(call:Call,workspace:string)=>call<AiTextSettings>(workspacePath(workspace,"ai-text"));
export const chooseAiText=(call:Call,workspace:string,providerId:AiTextProviderStatus["id"])=>call<AiTextSettings>(workspacePath(workspace,"ai-text"),"POST",{providerId});
export const aiTextStateLabel=(state:AiTextProviderState)=>state==="ready"?"Ready":state==="needs_key"?"Needs a key":"Sign in needed";
export const assetUrl=(workspace:string,id:string,download=false)=>`/api/v1${workspacePath(workspace,`assets/${encodeURIComponent(id)}/content`)}${download?"?download=1":""}`;
/** The exact delivery profiles the team server can make. They are fixed, never chosen by the browser. */
export type ExportProfileId="mp4-h264-720p24"|"mp4-h264-1080p24";
/** Makes a new muted MP4 asset from a finished video and returns it. Encoding can take minutes, so this waits longer than a normal call. */
export const exportAssetMp4=(call:Call,workspace:string,assetId:string,profileId:ExportProfileId)=>call<Asset>(workspacePath(workspace,`assets/${encodeURIComponent(assetId)}/exports`),"POST",{profileId},{timeoutMs:5*60_000});
export type Catalogue=CapabilityManifestV2[];
export type Call=<T>(path:string,method?:string,body?:unknown,options?:RequestOptions)=>Promise<T>;
export function mergeAssets(...groups:Asset[][]):Asset[]{return [...new Map(groups.flat().map(a=>[a.id,a])).values()];}
/** Pin restored references even when they no longer occur on the first page. */
export async function composerAssets(call:Call,workspace:string,project:string,selected:string[]):Promise<AssetPage>{
  const page=await call<AssetPage>(workspacePath(workspace,`assets?projectId=${project}`));
  const absent=[...new Set(selected)].filter(id=>!page.items.some(a=>a.id===id));
  const pinned=await Promise.all(absent.map(async id=>{
    try{const a=await call<Asset>(workspacePath(workspace,`assets/${encodeURIComponent(id)}`));return a.project_id===project?a:null;}
    catch(e){if(e instanceof ApiError&&e.status===404)return null;throw e;}
  }));
  return {...page,items:mergeAssets(page.items,pinned.filter((a):a is Asset=>!!a))};
}
