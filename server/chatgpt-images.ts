import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {mkdir,lstat,realpath,writeFile,readFile,unlink,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {member,HttpError} from './auth';
import {transaction} from './db';
import {newId,hashToken} from './crypto';
import {canonical,publicColumns} from './run-submission';
import type {DiskStore} from './storage';
import {createChatgptNative,CHATGPT_IMAGE_MODEL,type ChatgptNative,type NativeLogin} from './chatgpt-native';

const base='/api/v1/workspaces/:workspaceId/chatgpt-image';
const params=z.object({workspaceId:z.uuid()});
const inputSchema=z.object({source_image:z.uuid(),reference_image:z.uuid().optional(),reference_image_2:z.uuid().optional()}).strict();
const intent=z.object({projectId:z.uuid(),idempotencyKey:z.uuid(),feature:z.enum(['image-edit','image-angles','image-relight']),inputs:inputSchema,prompt:z.string().trim().min(1).max(20000),consent:z.object({subscriptionQuota:z.literal(true)}).strict()}).strict();
const policy=`cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\nmodel_provider = "openai"\nmodel = "${CHATGPT_IMAGE_MODEL}"\nmodel_reasoning_effort = "low"\nweb_search = "disabled"\n[features]\nimage_generation = true\nshell_tool = false\nmulti_agent = false\napps = false\nplugins = false\n`;
type Active={runId:string;workspaceId:string;abort:AbortController;done:Promise<void>;finish:()=>void};
type PendingLogin=NativeLogin&{expiresAt:number;timer:ReturnType<typeof setTimeout>};
/** Accounts are scoped to the authenticated user, never a request body or selected workspace. */
export class ChatgptImageService {
 private logins=new Map<string,PendingLogin>();private active=new Map<string,Active>();private accountBusy=new Set<string>();
 private leader:PoolClient|undefined;private leaderStarting:Promise<void>|undefined;private closed=false;
 constructor(readonly pool:Pool,readonly store:DiskStore,readonly native:ChatgptNative=createChatgptNative()){}
 private async directory(parent:string,name:string){await mkdir(parent,{recursive:true,mode:0o700});const root=await realpath(parent),dir=join(root,name);await mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});if((await lstat(dir)).isSymbolicLink()||dirname(await realpath(dir))!==root)throw new HttpError(503,'Private ChatGPT storage is unavailable.');return dir;}
 async profile(userId:string){z.uuid().parse(userId);const base=await this.directory(this.store.root,'.chatgpt'),home=await this.directory(base,userId);
  for(const name of ['auth.json','config.toml']){const entry=await lstat(join(home,name)).catch(()=>null);if(entry?.isSymbolicLink()||entry&&!entry.isFile())throw new HttpError(503,'Private ChatGPT profile is invalid.');}
  await writeFile(join(home,'config.toml'),policy,{mode:0o600});return home;
 }
 private async revision(userId:string){return (await this.pool.query('INSERT INTO chatgpt_image_accounts(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING revision',[userId])).rows[0].revision as string;}
 private async exclusive<T>(userId:string,work:()=>Promise<T>){if(this.closed)throw new HttpError(503,'ChatGPT connector is stopping.');if(this.accountBusy.has(userId))throw new HttpError(409,'A ChatGPT account action is already in progress.');this.accountBusy.add(userId);try{return await work();}finally{this.accountBusy.delete(userId);}}
 async status(userId:string){return this.exclusive(userId,async()=>{const revision=await this.revision(userId),login=this.logins.get(userId);if(login)return {connected:false,pending:true,revision,verificationUrl:login.verificationUrl,userCode:login.userCode,expiresAt:login.expiresAt};
  if(this.active.has(userId))return {connected:true,pending:false,revision,busy:true,model:CHATGPT_IMAGE_MODEL};
  const home=await this.profile(userId);if(!await lstat(join(home,'auth.json')).catch(()=>null))return {connected:false,pending:false,revision};
  try{return {...await this.native.status(home),pending:false,revision,model:CHATGPT_IMAGE_MODEL};}catch{throw new HttpError(503,'Could not check your native ChatGPT sign-in. No render started.');}
 });}
 async login(userId:string){return this.exclusive(userId,async()=>{if(this.active.has(userId))throw new HttpError(409,'Wait for your current image edit or cancel it first.');const old=this.logins.get(userId);if(old)return {pending:true,verificationUrl:old.verificationUrl,userCode:old.userCode,expiresAt:old.expiresAt};
  if(this.logins.size>=16)throw new HttpError(429,'Too many sign-ins in progress.');
  const home=await this.profile(userId);await this.revision(userId);await this.pool.query('UPDATE chatgpt_image_accounts SET revision=revision+1,updated_at=now() WHERE user_id=$1',[userId]);
  const login=await this.native.login(home,()=>{const current=this.logins.get(userId);if(current){clearTimeout(current.timer);this.logins.delete(userId);}});
  const expiresAt=Date.now()+300000,timer=setTimeout(()=>{const current=this.logins.get(userId);if(current===pending){this.logins.delete(userId);void current.close();}},300000),pending={...login,expiresAt,timer};timer.unref?.();this.logins.set(userId,pending);
  return {pending:true,verificationUrl:login.verificationUrl,userCode:login.userCode,expiresAt};
 });}
 async cancelLogin(userId:string){return this.exclusive(userId,async()=>{const login=this.logins.get(userId);if(login){this.logins.delete(userId);clearTimeout(login.timer);await login.close();}return {canceled:true};});}
 async logout(userId:string){return this.exclusive(userId,async()=>{const login=this.logins.get(userId);if(login){this.logins.delete(userId);clearTimeout(login.timer);await login.close();}
  // Revoke first; late results cannot be published after disconnect.
  await this.revision(userId);await this.pool.query('UPDATE chatgpt_image_accounts SET revision=revision+1,updated_at=now() WHERE user_id=$1',[userId]);
  const active=this.active.get(userId);if(active){await this.pool.query("UPDATE runs SET state='cancel_requested',updated_at=now() WHERE id=$1 AND state IN ('pending','running')",[active.runId]);active.abort.abort();await active.done;}
  const home=await this.profile(userId);try{await this.native.logout(home);}finally{await unlink(join(home,'auth.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  return {connected:false};
 });}
 private async becomeLeader(){if(this.leader)return;if(this.leaderStarting)return this.leaderStarting;
  this.leaderStarting=(async()=>{const client=await this.pool.connect();try{const r=await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_schema()||':chatgpt-images',0)) AS locked");if(!r.rows[0].locked)throw new HttpError(503,'Another ComfyField process owns ChatGPT image jobs.');this.leader=client;
   await client.query("WITH stopped AS (UPDATE runs SET state=CASE WHEN state='cancel_requested' THEN 'canceled' ELSE 'failed' END,error='The server stopped before this image edit completed. It was not retried.',updated_at=now() WHERE route_id='chatgpt-native' AND state IN ('pending','running','cancel_requested') RETURNING workspace_id,id,state) INSERT INTO run_events(workspace_id,run_id,state) SELECT workspace_id,id,state FROM stopped");
  }catch(e){if(this.leader===client)this.leader=undefined;client.release(true);throw e;}})();try{await this.leaderStarting;}finally{this.leaderStarting=undefined;}
 }
 async recover(){if((await this.pool.query("SELECT id FROM runs WHERE route_id='chatgpt-native' AND state IN ('pending','running','cancel_requested') LIMIT 1")).rowCount){try{await this.becomeLeader();}catch(e){if(!(e instanceof HttpError&&e.statusCode===503))throw e;}}}
 async submit(workspaceId:string,userId:string,raw:unknown){const body=intent.parse(raw),requestHash=hashToken(canonical({userId,...body}));
  // Lookup before account readiness so a lost acknowledgement can never cause a second model turn.
  const prior=(await this.pool.query(`SELECT ${publicColumns},request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];if(prior){if(prior.request_hash!==requestHash)throw new HttpError(409,'Request ID already belongs to a different edit.');delete prior.request_hash;return prior;}
  return this.exclusive(userId,async()=>{if(this.active.has(userId)||this.logins.has(userId))throw new HttpError(409,'Finish sign-in or your current image edit first.');if(this.active.size>=4)throw new HttpError(429,'The ChatGPT image queue is full.');await this.becomeLeader();
   const home=await this.profile(userId),account=await this.native.status(home);if(!account.connected)throw new HttpError(422,'Sign in to ChatGPT for your ComfyField account first.');
   const revision=await this.revision(userId),id=newId(),abort=new AbortController();let finish=()=>{};const done=new Promise<void>(resolve=>{finish=resolve;});const active={runId:id,workspaceId,abort,done,finish};
   const created=await transaction(this.pool,async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${workspaceId}/${body.idempotencyKey}`]);
    const previous=(await client.query(`SELECT ${publicColumns},request_hash FROM runs WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,body.idempotencyKey])).rows[0];if(previous){if(previous.request_hash!==requestHash)throw new HttpError(409,'Request ID already belongs to a different edit.');delete previous.request_hash;return {run:previous,fresh:false};}
    if(!(await client.query('SELECT id FROM projects WHERE workspace_id=$1 AND id=$2',[workspaceId,body.projectId])).rowCount)throw new HttpError(404,'Project not found.');
    const ids=Object.values(body.inputs).filter(Boolean),assets=(await client.query('SELECT id,storage_key,sha256,bytes,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=ANY($3::uuid[])',[workspaceId,body.projectId,ids])).rows;
    if(ids.some(id=>!assets.some(a=>a.id===id))||assets.some(a=>!['image/png','image/jpeg','image/webp'].includes(a.content_type))||ids.reduce((n,id)=>n+Number(assets.find(a=>a.id===id)?.bytes??0),0)>18*1024*1024)throw new HttpError(400,'Use project-owned PNG, JPEG or WebP images, up to 18 MB combined.');
    if(body.inputs.reference_image_2&&!body.inputs.reference_image)throw new HttpError(400,'Add the first reference before the second.');
    const invocation={capabilityId:'chatgpt-image-edit',version:'1.0.0',routeId:'chatgpt-native',inputs:body.inputs,controls:{prompt:body.prompt},audioPolicy:'mute',consent:body.consent,native:{provider:'chatgpt',model:CHATGPT_IMAGE_MODEL,accountUserId:userId,accountRevision:String(revision),feature:body.feature}};
    const run=(await client.query(`INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,transport,invocation,request_hash,idempotency_key) VALUES($1,$2,$3,$4,'chatgpt-image-edit','1.0.0','chatgpt-native','pending','chatgpt',$5,$6,$7) RETURNING ${publicColumns}`,[id,workspaceId,body.projectId,userId,JSON.stringify(invocation),requestHash,body.idempotencyKey])).rows[0];
    for(const [role,assetId] of Object.entries(body.inputs))await client.query('INSERT INTO run_inputs(workspace_id,run_id,asset_id,role) VALUES($1,$2,$3,$4)',[workspaceId,id,assetId,role]);
    await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'pending')",[workspaceId,id]);return {run:{...run,workspace_id:workspaceId,invocation},fresh:true};
   });
   if(created.fresh){this.active.set(userId,active);void this.run(created.run,home,active).finally(()=>{if(this.active.get(userId)===active)this.active.delete(userId);active.finish();});}return created.run;
  });
 }
 private async run(run:any,home:string,active:Active){let candidate:{key:string}|undefined;try{
  const changed=await this.pool.query("UPDATE runs SET state='running',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' RETURNING id",[run.workspace_id,run.id]);if(!changed.rowCount)return;
  await this.pool.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'running')",[run.workspace_id,run.id]);
  const jobs=await this.directory(home,'jobs'),cwd=await this.directory(jobs,run.id),paths:string[]=[];
  for(const [role,id] of Object.entries(run.invocation.inputs)){
   const asset=(await this.pool.query('SELECT storage_key,sha256,content_type FROM assets WHERE workspace_id=$1 AND project_id=$2 AND id=$3',[run.workspace_id,run.project_id,id])).rows[0];if(!asset)throw new Error('An input image is no longer available.');
   const source=await this.store.file(run.workspace_id,asset.storage_key);if((await stat(source)).size>18*1024*1024)throw new Error('An input image exceeds the size limit.');const bytes=await readFile(source);if(bytes.length>18*1024*1024||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error('An input image changed after submission.');await sharp(bytes,{limitInputPixels:4096*4096}).stats();
   const path=join(cwd,`${role}.${asset.content_type==='image/jpeg'?'jpg':asset.content_type==='image/webp'?'webp':'png'}`);await writeFile(path,bytes,{flag:'wx',mode:0o600});paths.push(path);
  }
  if(active.abort.signal.aborted)throw new Error('Image edit canceled.');
  const output=await this.native.edit(home,cwd,paths,run.invocation.controls.prompt,active.abort.signal);if(output.model!==CHATGPT_IMAGE_MODEL)throw new Error('The native model differed from the selected model.');
  if(active.abort.signal.aborted)throw new Error('Image edit canceled.');
  const image=sharp(output.bytes,{limitInputPixels:4096*4096}),metadata=await image.metadata();if(!['png','jpeg','webp'].includes(metadata.format??''))throw new Error('Native output is not a supported image.');await image.stats();
  const id=newId(),saved=await this.store.put(run.workspace_id,Readable.from(output.bytes));candidate=saved;
  await transaction(this.pool,async client=>{const account=(await client.query('SELECT revision FROM chatgpt_image_accounts WHERE user_id=$1 FOR UPDATE',[run.created_by])).rows[0],current=(await client.query('SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[run.workspace_id,run.id])).rows[0];
   // Membership is checked again: revocation while the job runs must not publish.
   const membership=(await client.query("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND role IN ('creator','admin')",[run.workspace_id,run.created_by])).rows[0];
   if(!membership||!current||current.state!=='running'||active.abort.signal.aborted||String(account?.revision)!==run.invocation.native.accountRevision)throw new Error('The edit was canceled or its account access changed.');
   const meta={width:metadata.width,height:metadata.height,provider:'chatgpt',model:output.model,runtime:output.runtime,sourceAssetIds:Object.values(run.invocation.inputs)};
   await client.query("INSERT INTO assets(id,workspace_id,project_id,parent_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,'ChatGPT image edit','image',$5,$6,$7,$8,$9,$10)",[id,run.workspace_id,run.project_id,run.invocation.inputs.source_image,`image/${metadata.format}`,saved.key,saved.sha256,saved.bytes,run.created_by,JSON.stringify(meta)]);
   await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify([id]),run.workspace_id,run.id]);await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'succeeded')",[run.workspace_id,run.id]);
  });candidate=undefined;
 }catch(e){const reason=active.abort.signal.aborted?'Image edit canceled.':(e as Error).message;
  await transaction(this.pool,async client=>{const r=await client.query("UPDATE runs SET state=CASE WHEN state IN ('cancel_requested','canceled') OR $3 THEN 'canceled' ELSE 'failed' END,error=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('succeeded','failed') RETURNING state",[run.workspace_id,run.id,active.abort.signal.aborted,reason.slice(0,2000)]);if(r.rowCount)await client.query('INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)',[run.workspace_id,run.id,r.rows[0].state]);}).catch(()=>{});
 }finally{if(candidate){const existing=await this.pool.query('SELECT id FROM assets WHERE workspace_id=$1 AND storage_key=$2',[run.workspace_id,candidate.key]).catch(()=>null);if(existing?.rowCount===0)await this.store.remove(run.workspace_id,candidate.key).catch(()=>{});}}
 }
 async cancel(workspaceId:string,id:string){const active=[...this.active.values()].find(a=>a.workspaceId===workspaceId&&a.runId===id);if(active){active.abort.abort();await active.done;}}
 async settled(id:string){await [...this.active.values()].find(a=>a.runId===id)?.done;}
 async close(){this.closed=true;for(const login of this.logins.values()){clearTimeout(login.timer);await login.close();}this.logins.clear();for(const a of this.active.values())a.abort.abort();await Promise.all([...this.active.values()].map(a=>a.done));if(this.leader){await this.leader.query("SELECT pg_advisory_unlock(hashtextextended(current_schema()||':chatgpt-images',0))").catch(()=>{});this.leader.release();this.leader=undefined;}}
}
export async function chatgptImageRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,native?:ChatgptNative){const service=new ChatgptImageService(pool,store,native);
 await service.recover();
 app.get(`${base}/account`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId);return service.status(user.id);});
 app.post(`${base}/login`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId,'creator');return service.login(user.id);});
 app.post(`${base}/login/cancel`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId,'creator');return service.cancelLogin(user.id);});
 app.post(`${base}/logout`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId);return service.logout(user.id);});
 app.post(`${base}/runs`,async request=>{const {workspaceId}=params.parse(request.params),user=await member(pool,request,workspaceId,'creator');return service.submit(workspaceId,user.id,request.body);});
 app.addHook('onClose',()=>service.close());return service;
}
