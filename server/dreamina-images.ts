/* Dreamina images as ComfyField runs (route "dreamina-native"): the person's own Dreamina account through the CLI,
   one run row per image, the result stored as a project asset with its prompt, model and settings.
   States: pending -> running -> succeeded | failed | canceled (cancel_requested while the CLI stops).
   Account: signed out -> sign-in pending (device code, 10 min) -> signed in. A server stop fails open runs; it never retries,
   because Dreamina may already have charged credits. */
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {member,HttpError} from './auth';
import {transaction} from './db';
import {newId,hashToken} from './crypto';
import {canonical,publicColumns} from './run-submission';
import type {DiskStore} from './storage';
import {createDreaminaNative,dreaminaProfile,DREAMINA_IMAGE_MODELS,DREAMINA_RATIOS,DREAMINA_RESOLUTIONS,DREAMINA_MAX_CEILING,type DreaminaNative,type DreaminaLogin} from './dreamina-native';

export const DREAMINA_ROUTE='dreamina-native',DREAMINA_CAPABILITY='dreamina-image';
const base='/api/v1/workspaces/:workspaceId/dreamina-image';
const params=z.object({workspaceId:z.uuid()});
const REF_ROLES=['reference_image','reference_image_2','reference_image_3','reference_image_4','reference_image_5','reference_image_6'] as const;
const intent=z.object({
 projectId:z.uuid(),idempotencyKey:z.uuid(),
 model:z.enum(Object.keys(DREAMINA_IMAGE_MODELS) as [keyof typeof DREAMINA_IMAGE_MODELS,...(keyof typeof DREAMINA_IMAGE_MODELS)[]]),
 aspectRatio:z.enum(DREAMINA_RATIOS),resolution:z.enum(DREAMINA_RESOLUTIONS),
 prompt:z.string().trim().min(1).max(7000),
 inputs:z.object(Object.fromEntries(REF_ROLES.map(r=>[r,z.uuid().optional()])) as Record<typeof REF_ROLES[number],z.ZodOptional<z.ZodUUID>>).strict().default({}),
 consent:z.object({credits:z.literal(true),ceiling:z.number().int().min(1).max(DREAMINA_MAX_CEILING)}).strict(),
}).strict();
type Active={runId:string;workspaceId:string;abort:AbortController;done:Promise<void>};
const MB=1024*1024;

export class DreaminaImageService {
 private logins=new Map<string,DreaminaLogin>();private active=new Map<string,Active>();private closed=false;
 constructor(readonly pool:Pool,readonly store:DiskStore,readonly native:DreaminaNative=createDreaminaNative()){}
 private perUser(userId:string){return [...this.active.values()].filter(a=>a.runId&&this.owner.get(a.runId)===userId).length;}
 private owner=new Map<string,string>();
 async recover(){
  await this.pool.query("WITH stopped AS (UPDATE runs SET state=CASE WHEN state='cancel_requested' THEN 'canceled' ELSE 'failed' END,error='The server stopped before this Dreamina image finished. It was not retried; Dreamina may have charged it.',updated_at=now() WHERE route_id=$1 AND state IN ('pending','running','cancel_requested') RETURNING workspace_id,id,state) INSERT INTO run_events(workspace_id,run_id,state) SELECT workspace_id,id,state FROM stopped",[DREAMINA_ROUTE]);
 }
 async status(userId:string){
  const login=this.logins.get(userId);if(login)return {connected:false,pending:true,verificationUrl:login.verificationUrl,userCode:login.userCode,expiresAt:login.expiresAt};
  try{return {...await this.native.status(dreaminaProfile(userId)),pending:false};}catch(e){throw new HttpError(503,(e as Error).message||'Could not check the Dreamina sign-in.');}
 }
 async login(userId:string){
  const old=this.logins.get(userId);if(old)return {pending:true,verificationUrl:old.verificationUrl,userCode:old.userCode,expiresAt:old.expiresAt};
  if(this.logins.size>=16)throw new HttpError(429,'Too many sign-ins in progress.');
  let login:DreaminaLogin;try{login=await this.native.login(dreaminaProfile(userId));}catch(e){throw new HttpError(503,(e as Error).message);}
  this.logins.set(userId,login);void login.done.finally(()=>{if(this.logins.get(userId)===login)this.logins.delete(userId);});
  return {pending:true,verificationUrl:login.verificationUrl,userCode:login.userCode,expiresAt:login.expiresAt};
 }
 async cancelLogin(userId:string){const login=this.logins.get(userId);if(login){this.logins.delete(userId);login.close();}return {canceled:true};}
 async logout(userId:string){await this.cancelLogin(userId);await this.native.logout(dreaminaProfile(userId));return {connected:false};}
 async submit(workspaceId:string,userId:string,raw:unknown){
  const body=intent.parse(raw),requestHash=hashToken(canonical({userId,...body}));
  // Lookup first: a lost acknowledgement must never spend credits twice.
  const prior=(await this.pool.query(`SELECT ${publicColumns},request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];
  if(prior){if(prior.request_hash!==requestHash)throw new HttpError(409,'Request ID already belongs to a different image.');delete prior.request_hash;return prior;}
  if(this.closed)throw new HttpError(503,'Dreamina images are stopping.');
  if(this.perUser(userId)>=2)throw new HttpError(429,'Two Dreamina images are already running for you. Wait for one to finish.');
  const refs=REF_ROLES.filter(r=>body.inputs[r]);
  if(refs.length>DREAMINA_IMAGE_MODELS[body.model].maxRefs)throw new HttpError(400,'Too many reference images for this model.');
  if(body.prompt.length>DREAMINA_IMAGE_MODELS[body.model].maxPrompt)throw new HttpError(400,`${DREAMINA_IMAGE_MODELS[body.model].title} accepts prompts of up to ${DREAMINA_IMAGE_MODELS[body.model].maxPrompt} characters. Shorten the prompt.`);
  if(refs.some((r,i)=>r!==REF_ROLES[i]))throw new HttpError(400,'Add references in order, without gaps.');
  const profile=dreaminaProfile(userId),account=await this.native.status(profile).catch(()=>({connected:false}));
  if(!account.connected)throw new HttpError(422,'Sign in to Dreamina for your CreativeField account first.');
  const id=newId(),abort=new AbortController();
  const created=await transaction(this.pool,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${workspaceId}/${body.idempotencyKey}`]);
   const previous=(await client.query(`SELECT ${publicColumns},request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];
   if(previous){if(previous.request_hash!==requestHash)throw new HttpError(409,'Request ID already belongs to a different image.');delete previous.request_hash;return {run:previous,fresh:false};}
   if(!(await client.query('SELECT id FROM projects WHERE workspace_id=$1 AND id=$2',[workspaceId,body.projectId])).rowCount)throw new HttpError(404,'Project not found.');
   const ids=refs.map(r=>body.inputs[r]!),assets=ids.length?(await client.query('SELECT id,bytes,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[workspaceId,body.projectId,ids])).rows:[];
   if(ids.some(i=>!assets.some(a=>a.id===i))||assets.some(a=>!['image/png','image/jpeg','image/webp'].includes(a.content_type)||Number(a.bytes)>30*MB))throw new HttpError(400,'Use project-owned PNG, JPEG or WebP images of up to 30 MB as references.');
   const inputs=Object.fromEntries(refs.map(r=>[r,body.inputs[r]!]));
   const invocation={capabilityId:DREAMINA_CAPABILITY,version:'1.0.0',routeId:DREAMINA_ROUTE,inputs,controls:{prompt:body.prompt,model:body.model,aspect_ratio:body.aspectRatio,resolution:body.resolution},audioPolicy:'mute',consent:body.consent,native:{provider:'dreamina',model:body.model,accountUserId:userId}};
   const run=(await client.query(`INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,transport,invocation,request_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,'1.0.0',$6,'pending','dreamina',$7,$8,$9) RETURNING ${publicColumns}`,[id,workspaceId,body.projectId,userId,DREAMINA_CAPABILITY,DREAMINA_ROUTE,JSON.stringify(invocation),requestHash,body.idempotencyKey])).rows[0];
   for(const [role,assetId] of Object.entries(inputs))await client.query('INSERT INTO run_inputs(workspace_id,run_id,asset_id,role) VALUES($1,$2,$3,$4)',[workspaceId,id,assetId,role]);
   await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'pending')",[workspaceId,id]);
   return {run:{...run,workspace_id:workspaceId,invocation},fresh:true};
  });
  if(created.fresh){
   let finish=()=>{};const done=new Promise<void>(resolve=>{finish=resolve;});const active:Active={runId:id,workspaceId,abort,done};
   this.active.set(id,active);this.owner.set(id,userId);
   void this.run(created.run,profile,active).finally(()=>{this.active.delete(id);this.owner.delete(id);finish();});
  }
  return created.run;
 }
 private async event(runId:string,workspaceId:string,state:string){await this.pool.query('INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)',[workspaceId,runId,state]);}
 private async run(run:any,profile:string,active:Active){
  const work=join(this.store.root,'.dreamina-jobs',run.id);let candidate:{key:string}|undefined;
  try{
   const changed=await this.pool.query("UPDATE runs SET state='running',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' RETURNING id",[run.workspace_id,run.id]);if(!changed.rowCount)return;
   await this.event(run.id,run.workspace_id,'running');
   await mkdir(work,{recursive:true,mode:0o700});const files:string[]=[];
   for(const [role,assetId] of Object.entries(run.invocation.inputs as Record<string,string>)){
    const asset=(await this.pool.query('SELECT storage_key,sha256,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3',[run.workspace_id,run.project_id,assetId])).rows[0];if(!asset)throw new Error('A reference image is no longer available.');
    const source=await this.store.file(run.workspace_id,asset.storage_key);if((await stat(source)).size>30*MB)throw new Error('A reference image exceeds the size limit.');
    const bytes=await readFile(source);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error('A reference image changed after submission.');
    const file=join(work,`${role}.${asset.content_type==='image/jpeg'?'jpg':asset.content_type==='image/webp'?'webp':'png'}`);await writeFile(file,bytes,{mode:0o600});files.push(file);
   }
   if(active.abort.signal.aborted)throw new Error('Image generation canceled.');
   const c=run.invocation.controls;
   const out=await this.native.generate(profile,work,{model:c.model,ratio:c.aspect_ratio,resolution:c.resolution,prompt:c.prompt,references:files,creditCeiling:run.invocation.consent.ceiling,title:`CreativeField ${run.id.slice(0,8)}`},active.abort.signal);
   if(active.abort.signal.aborted)throw new Error('Image generation canceled.');
   const image=sharp(out.bytes,{limitInputPixels:8192*8192}),meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format??''))throw new Error('Dreamina returned an unsupported image.');await image.stats();
   const assetId=newId(),saved=await this.store.put(run.workspace_id,Readable.from(out.bytes));candidate=saved;
   await transaction(this.pool,async client=>{
    const current=(await client.query('SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[run.workspace_id,run.id])).rows[0];
    const membership=(await client.query("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('creator','admin')",[run.workspace_id,run.created_by])).rows[0];
    if(!membership||current?.state!=='running'||active.abort.signal.aborted)throw new Error('The image was canceled or your access changed.');
    const metadata={width:meta.width,height:meta.height,provider:'dreamina',model:out.model,modelTitle:DREAMINA_IMAGE_MODELS[out.model as keyof typeof DREAMINA_IMAGE_MODELS]?.title,credits:out.credits,sourceAssetIds:Object.values(run.invocation.inputs)};
    const parent=(run.invocation.inputs as Record<string,string>).reference_image??null;
    await client.query("INSERT INTO assets(id,workspace_id,project_id,parent_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,'Dreamina image','image',$5,$6,$7,$8,$9,$10)",[assetId,run.workspace_id,run.project_id,parent,`image/${meta.format}`,saved.key,saved.sha256,saved.bytes,run.created_by,JSON.stringify(metadata)]);
    await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify([assetId]),run.workspace_id,run.id]);
    await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'succeeded')",[run.workspace_id,run.id]);
   });candidate=undefined;
  }catch(e){
   const reason=active.abort.signal.aborted?'Image generation canceled.':(e as Error).message;
   await transaction(this.pool,async client=>{const r=await client.query("UPDATE runs SET state=CASE WHEN state IN ('cancel_requested','canceled') OR $3 THEN 'canceled' ELSE 'failed' END,error=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed') RETURNING state",[run.workspace_id,run.id,active.abort.signal.aborted,reason.slice(0,2000)]);if(r.rowCount)await client.query('INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)',[run.workspace_id,run.id,r.rows[0].state]);}).catch(()=>{});
  }finally{
   await rm(work,{recursive:true,force:true}).catch(()=>{});
   if(candidate){const existing=await this.pool.query('SELECT id FROM assets WHERE workspace_id=$1 AND storage_key=$2',[run.workspace_id,candidate.key]).catch(()=>null);if(existing?.rowCount===0)await this.store.remove(run.workspace_id,candidate.key).catch(()=>{});}
  }
 }
 async cancel(workspaceId:string,id:string){const active=this.active.get(id);if(active&&active.workspaceId===workspaceId){active.abort.abort();await active.done;}}
 async settled(id:string){await this.active.get(id)?.done;}
 async close(){this.closed=true;for(const l of this.logins.values())l.close();this.logins.clear();for(const a of this.active.values())a.abort.abort();await Promise.all([...this.active.values()].map(a=>a.done));}
}
export async function dreaminaImageRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,native?:DreaminaNative){
 const service=new DreaminaImageService(pool,store,native);await service.recover();
 app.get(`${base}/models`,async request=>{const {workspaceId}=params.parse(request.params);await member(pool,request,workspaceId);return {models:Object.entries(DREAMINA_IMAGE_MODELS).map(([id,m])=>({id,...m})),ratios:DREAMINA_RATIOS,resolutions:DREAMINA_RESOLUTIONS,maxCeiling:DREAMINA_MAX_CEILING};});
 app.get(`${base}/account`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId);return service.status(user.id);});
 app.post(`${base}/login`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId,'creator');return service.login(user.id);});
 app.post(`${base}/login/cancel`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId,'creator');return service.cancelLogin(user.id);});
 app.post(`${base}/logout`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId);return service.logout(user.id);});
 app.post(`${base}/runs`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId,'creator');return service.submit(workspaceId,user.id,request.body);});
 app.addHook('onClose',()=>service.close());return service;
}
