import type {Pool} from "pg";
import {existsSync,readFileSync} from "node:fs";
import {homedir} from "node:os";
import {delimiter,join} from "node:path";
import {HttpError} from "./auth";
import {aiTextConfig,type AiTextConfig} from "./config";
import {chatGptCodexProvider} from "./ai-text/chatgpt-codex";
import {localComfyProvider} from "./ai-text/local-comfy";
import {openAiCompatibleProvider} from "./ai-text/openai-compatible";

/** The text providers the server can actually reach. One implementation per id in ./ai-text/. */
export type AiTextProviderId="local-comfy"|"openai-compatible"|"chatgpt";

/** One image handed to a provider, already read from disk. Text-only requests leave images out. */
export type AiTextImage={mediaType:string;bytes:Uint8Array};

export type AiTextRequest={
  /** What the model answers under. Providers put it first. */
  system:string;
  /** The single user turn: the premise, the question, the frame to read. */
  prompt:string;
  /** Optional images, so still and frame analysis can use this same seam later. */
  images?:readonly AiTextImage[];
  /** Upper bound for the answer, in tokens. */
  maxTokens?:number;
  /** Ask for a JSON object, for callers that parse the answer. */
  json?:boolean;
  /** What the caller wants back. `image` is refused by a provider that cannot make pictures. */
  kind?:"text"|"image";
  /** Workspace whose worker or stored provider setting serves the request. */
  workspaceId:string;
};

export type AiTextResult={provider:AiTextProviderId;model:string;text:string};
export type AiTextContext={pool:Pool};
/** A provider answers, or throws the HttpError the route shows unchanged. */
export type AiTextProvider={
  id:AiTextProviderId;
  generate(request:AiTextRequest,context:AiTextContext):Promise<AiTextResult>;
};

const providers:readonly AiTextProvider[]=[localComfyProvider,openAiCompatibleProvider,chatGptCodexProvider];

/** The one seam for model-written text. Feature routes call this and never a provider file. */
export async function generateText(providerId:AiTextProviderId|"active",request:AiTextRequest,context:AiTextContext):Promise<AiTextResult>{
  // "active" is the workspace's own choice, or the first provider that can run when it has none.
  const chosen=providerId==="active"?(await aiTextSettings(context.pool,request.workspaceId)).active:providerId;
  const provider=providers.find(candidate=>candidate.id===chosen);
  if(!provider)throw chosen?new HttpError(503,`No text provider is installed for ${chosen}.`):new HttpError(503,"Choose where AI text runs in Settings first.");
  return await provider.generate(request,context);
}

/* ── Where AI text runs: one choice per workspace, plus what each provider needs first ── */

/** Ready, or the one missing thing: a key, or a Codex sign-in. */
export type AiTextProviderState="ready"|"needs_key"|"needs_sign_in";

export type AiTextProviderStatus={
  id:AiTextProviderId;
  label:string;
  state:AiTextProviderState;
  /** One short line: the fact, or the step that makes this provider work. Never a secret. */
  detail:string;
};

export type AiTextSettings={providers:AiTextProviderStatus[];active?:AiTextProviderId};

export type AiTextFacts={
  /** An enabled ComfyUI worker answered its last probe. */
  localWorker:boolean;
  config:AiTextConfig|undefined;
  /** The Codex app-server can start on this machine. */
  codex:boolean;
  /** That Codex is signed in to a ChatGPT plan, not an API key. */
  signedIn:boolean;
};

/** Where Codex keeps the sign-in it wrote. Defaults to ~/.codex, as Codex itself does. */
export function codexHome(env:NodeJS.ProcessEnv=process.env){
  return env.CODEX_HOME?.trim()||join(homedir(),".codex");
}

/** Whether `codex` can start here. Only a path is looked at, never a file's content. */
export function codexInstalled(env:NodeJS.ProcessEnv=process.env,platform=process.platform):boolean{
  const named=env.COMFYFIELD_CODEX_BIN?.trim();
  if(named)return existsSync(named);
  const names=platform==="win32"?["codex.cmd","codex.exe","codex.bat"]:["codex"];
  const path=env.PATH??env.Path??"";
  return path.split(platform==="win32"?";":delimiter).some(dir=>!!dir&&names.some(name=>existsSync(join(dir,name))));
}

/** Whether Codex holds a ChatGPT token. Neither the token nor the rest of the file leaves this function. */
export function codexSignedIn(env:NodeJS.ProcessEnv=process.env):boolean{
  try{
    const auth=JSON.parse(readFileSync(join(codexHome(env),"auth.json"),"utf8")) as {tokens?:{access_token?:unknown}};
    return typeof auth?.tokens?.access_token==="string"&&auth.tokens.access_token.length>0;
  }catch{return false;}
}

/** The worker that would write the text has to be up: a registered worker that is offline cannot. */
export async function localTextReady(pool:Pool,workspaceId:string):Promise<boolean>{
  const worker=(await pool.query("SELECT inventory FROM workers WHERE workspace_id=$1 AND enabled=true ORDER BY checked_at DESC NULLS LAST,id LIMIT 1",[workspaceId])).rows[0] as {inventory:{online?:boolean}|null}|undefined;
  return worker?.inventory?.online===true;
}

const LOCAL_HOSTS=new Set(["127.0.0.1","localhost","[::1]"]);

/** A keyless endpoint on this machine answers without a key; one reached over the network needs it. */
function needsKey(config:AiTextConfig){
  if(config.apiKey)return false;
  try{return !LOCAL_HOSTS.has(new URL(config.url).hostname);}catch{return true;}
}

/** Only the providers that can run here, each with the one line an admin needs. A provider that cannot work is left out. */
export function availableProviders(facts:AiTextFacts):AiTextProviderStatus[]{
  const list:AiTextProviderStatus[]=[];
  if(facts.localWorker)list.push({id:"local-comfy",label:"Local ComfyUI",state:"ready",detail:"Writes on your own ComfyUI worker. No key needed."});
  if(facts.config){
    const keyed=needsKey(facts.config);
    list.push({id:"openai-compatible",label:"API key",state:keyed?"needs_key":"ready",detail:keyed?"Set COMFYFIELD_LLM_API_KEY on the server.":facts.config.model});
  }
  if(facts.codex)list.push({id:"chatgpt",label:"ChatGPT",state:facts.signedIn?"ready":"needs_sign_in",detail:facts.signedIn?"Uses your ChatGPT plan through Codex.":"Run codex login in a terminal first."});
  return list;
}

/**
 * The chosen provider is one row per workspace in a table of its own. It holds no key and no secret,
 * so the seam creates it on first use rather than carrying a migration for a single setting.
 */
const SETTINGS_TABLE="CREATE TABLE IF NOT EXISTS ai_text_settings(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), provider_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())";
const ensured=new WeakSet<Pool>();

async function settingsTable(pool:Pool){
  if(ensured.has(pool))return;
  await pool.query(SETTINGS_TABLE);
  ensured.add(pool);
}

export async function activeTextProvider(pool:Pool,workspaceId:string):Promise<AiTextProviderId|undefined>{
  await settingsTable(pool);
  const saved=(await pool.query("SELECT provider_id FROM ai_text_settings WHERE workspace_id=$1",[workspaceId])).rows[0] as {provider_id:string}|undefined;
  const found=providers.find(candidate=>candidate.id===saved?.provider_id);
  return found?.id;
}

export async function setActiveTextProvider(pool:Pool,workspaceId:string,providerId:AiTextProviderId):Promise<void>{
  await settingsTable(pool);
  await pool.query("INSERT INTO ai_text_settings(workspace_id,provider_id) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET provider_id=EXCLUDED.provider_id,updated_at=now()",[workspaceId,providerId]);
}

/** A half-configured endpoint stops the server at start; while answering a request it only means "not here". */
function readConfig(env:NodeJS.ProcessEnv){
  try{return aiTextConfig(env);}catch{return undefined;}
}

/** What this workspace can use and which provider is active. A saved choice counts only while it can still run. */
export async function aiTextSettings(pool:Pool,workspaceId:string,env:NodeJS.ProcessEnv=process.env):Promise<AiTextSettings>{
  const facts:AiTextFacts={localWorker:await localTextReady(pool,workspaceId),config:readConfig(env),codex:codexInstalled(env),signedIn:codexSignedIn(env)};
  const list=availableProviders(facts);
  const saved=await activeTextProvider(pool,workspaceId);
  const active=list.find(provider=>provider.id===saved&&provider.state==="ready")??list.find(provider=>provider.state==="ready");
  return {providers:list,active:active?.id};
}
