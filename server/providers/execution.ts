import type {Pool} from "pg";
import type {DiskStore} from "../storage";
import {transaction} from "../db";
import {decryptProviderSecret,newId} from "../crypto";
import {probeVideo} from "../media";
import sharp from 'sharp';
import {productionDirectRegistry,type DirectRegistry,type RegisteredAdapter} from "./registry";
import {createProviderTransport} from "./transport";
import type {AdapterContext,AdapterTransport,DirectBinding,OwnedInput} from "./types";

export type TransportFactory=(binding:DirectBinding,authorization:string)=>AdapterTransport;
export type ProviderDependencies={registry?:DirectRegistry;transportFactory?:TransportFactory};
const active="('pending','submitting','submission_unknown','queued','running','cancel_requested')";
const remoteId=(v:unknown):v is string=>typeof v==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(v);
const terminal=(s:string)=>["succeeded","failed","canceled"].includes(s);
const messages={credential:"Pinned provider credentials changed or are unavailable; execution is suspended.",binding:"Pinned provider adapter is unavailable or changed; execution is suspended.",outage:"Provider status is unavailable; read-only reconciliation will retry.",unknown:"Submission outcome is unknown; generation will not be automatically resubmitted.",output:"Output verification or import failed; only artifact import will retry."};

/** Server construction only. No runtime registry, endpoint or transport overrides from HTTP/config. */
export class DirectExecutionService {
  readonly registry:DirectRegistry;
  private readonly transportFactory:TransportFactory;
  private inFlight:Promise<void>|null=null;
  private stopped=false;
  constructor(readonly pool:Pool,readonly store:DiskStore,private readonly masterKey:Buffer,deps:ProviderDependencies={}){
    this.registry=deps.registry??productionDirectRegistry;this.transportFactory=deps.transportFactory??createProviderTransport;
  }
  tick():Promise<void>{if(this.stopped)return Promise.resolve();if(this.inFlight)return this.inFlight;this.inFlight=this.reconcileAll().finally(()=>{this.inFlight=null;});return this.inFlight;}
  async close(){this.stopped=true;await this.inFlight;}
  private async reconcileAll(){
    const candidates=(await this.pool.query(`SELECT r.id,r.workspace_id FROM runs r JOIN provider_run_bindings b ON b.workspace_id=r.workspace_id AND b.run_id=r.id WHERE r.state IN ${active} AND b.next_poll_at<=now() ORDER BY r.created_at LIMIT 100`)).rows;
    for(const candidate of candidates){
      const lock=await this.pool.connect(),key=`direct:${candidate.workspace_id}:${candidate.id}`;
      let acquired=false;
      try{
        acquired=(await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) acquired",[key])).rows[0].acquired;
        if(!acquired)continue;
        const run=(await this.pool.query(`SELECT r.*,b.manifest,b.binding,b.binding_hash,b.connection_id,b.credential_revision,b.request_token,b.phase,b.cancel_attempted,b.poll_failures FROM runs r JOIN provider_run_bindings b ON b.workspace_id=r.workspace_id AND b.run_id=r.id WHERE r.workspace_id=$1 AND r.id=$2 AND r.state IN ${active} AND b.next_poll_at<=now()`,[candidate.workspace_id,candidate.id])).rows[0];
        if(run)try{await this.reconcile(run);}catch{await this.defer(run,messages.outage);}
      }finally{try{if(acquired)await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[key]);}finally{lock.release();}}
    }
  }
  private async credential(run:any){
    const row=(await this.pool.query("SELECT encrypted_secret FROM provider_connections WHERE workspace_id=$1 AND id=$2 AND provider_id=$3 AND credential_revision=$4",[run.workspace_id,run.connection_id,run.binding.provider,run.credential_revision])).rows[0];
    if(!row)throw new Error("Pinned credentials unavailable");
    return decryptProviderSecret(row.encrypted_secret,this.masterKey,{workspaceId:run.workspace_id,providerId:run.binding.provider});
  }
  private async context(run:any,entry:RegisteredAdapter):Promise<AdapterContext>{
    const secret=await this.credential(run),transport=this.transportFactory(entry.binding,`Bearer ${secret}`);
    // Recheck on every network operation, including after a long input preparation.
    const guarded:AdapterTransport={api:async(path,options)=>{await this.credential(run);return transport.api(path,options);},artifact:async(url,max)=>{await this.credential(run);return transport.artifact(url,max);},...(transport.upload?{upload:async(input:OwnedInput)=>{await this.credential(run);return transport.upload!(input);}}:{})};
    return {requestId:run.request_token,binding:entry.binding,transport:guarded};
  }
  private async state(run:any){return (await this.pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[run.workspace_id,run.id])).rows[0]?.state;}
  private async transition(run:any,state:string,error:string|null=null,id?:string){
    await transaction(this.pool,async client=>{
      const row=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[run.workspace_id,run.id])).rows[0];
      if(!row||terminal(row.state))return;
      const next=row.state==="cancel_requested"&&["queued","running","submission_unknown"].includes(state)?row.state:state;
      await client.query("UPDATE runs SET state=$1,error=$2,remote_id=COALESCE($3,remote_id),updated_at=now() WHERE workspace_id=$4 AND id=$5",[next,error,id??null,run.workspace_id,run.id]);
      if(next!==row.state)await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,$3)",[run.workspace_id,run.id,next]);
    });
  }
  private async defer(run:any,error:string){
    await transaction(this.pool,async client=>{
      await client.query(`UPDATE runs SET error=$1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND state IN ${active}`,[error,run.workspace_id,run.id]);
      await client.query("UPDATE provider_run_bindings SET poll_failures=LEAST(poll_failures+1,8),next_poll_at=now()+(LEAST(60,2*power(2,LEAST(poll_failures,5)))*interval '1 second') WHERE workspace_id=$1 AND run_id=$2",[run.workspace_id,run.id]);
    });
  }
  private async dueLater(run:any){await this.pool.query("UPDATE provider_run_bindings SET poll_failures=0,next_poll_at=now()+interval '2 seconds' WHERE workspace_id=$1 AND run_id=$2",[run.workspace_id,run.id]);}
  private async reconcile(run:any){
    const entry=this.registry.resolve(run.manifest,run.route_id);
    if(!entry||entry.hash!==run.binding_hash){await this.defer(run,messages.binding);return;}
    let context:AdapterContext;
    try{context=await this.context(run,entry);}catch{await this.defer(run,messages.credential);return;}
    if(run.state==="pending"){await this.submit(run,entry,context);return;}
    // No billable submission was started: do not repeat potentially mutating uploads.
    if(run.phase==="preparing"||run.phase==="not_started"){
      await this.transition(run,await this.state(run)==="cancel_requested"?"canceled":"failed","Provider preparation was interrupted before generation; inputs were not automatically uploaded again.");return;
    }
    if(!run.remote_id){
      await this.transition(run,"submission_unknown",messages.unknown);
      if(entry.adapter.recovery!=="lookup"){await this.defer(run,messages.unknown);return;}
      let found;try{found=await entry.adapter.recover(context);}catch{await this.defer(run,messages.unknown);return;}
      if(found?.kind!=="found"||!remoteId(found.remoteId)){await this.defer(run,messages.unknown);return;}
      run.remote_id=found.remoteId;
      await this.transition(run,"queued",null,run.remote_id);
      await this.pool.query("UPDATE provider_run_bindings SET phase='accepted' WHERE workspace_id=$1 AND run_id=$2",[run.workspace_id,run.id]);
    }
    let observation;try{observation=await entry.adapter.poll(run.remote_id,context);}catch{await this.defer(run,messages.outage);return;}
    if(observation?.state==="succeeded"){await this.ingest(run,entry,context);return;}
    if(observation?.state==="canceled"){await this.transition(run,"canceled");return;}
    if(observation?.state==="failed"){await this.transition(run,"failed","Provider generation failed.");return;}
    if(!["pending","running"].includes(observation?.state)){await this.defer(run,messages.outage);return;}
    await this.dueLater(run);
    if(await this.state(run)==="cancel_requested"){
      if(entry.adapter.cancellation!=="supported"){await this.defer(run,"This provider cannot cancel an accepted generation; status reconciliation continues.");return;}
      const attempt=await this.pool.query("UPDATE provider_run_bindings SET cancel_attempted=true WHERE workspace_id=$1 AND run_id=$2 AND cancel_attempted=false RETURNING run_id",[run.workspace_id,run.id]);
      if(!attempt.rowCount)return;
      let result;try{result=await entry.adapter.cancel(run.remote_id,context);}catch{result={kind:"unknown"};}
      if(result?.kind==="confirmed")await this.transition(run,"canceled");
      else await this.defer(run,"Cancellation is not confirmed; read-only status reconciliation continues.");
      return;
    }
    await this.transition(run,observation.state==="running"?"running":"queued");
  }
  private async submit(run:any,entry:RegisteredAdapter,context:AdapterContext){
    const claimed=await transaction(this.pool,async client=>{
      const updated=await client.query("UPDATE runs SET state='submitting',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' RETURNING id",[run.workspace_id,run.id]);
      if(!updated.rowCount)return false;
      await client.query("UPDATE provider_run_bindings SET phase='preparing' WHERE workspace_id=$1 AND run_id=$2",[run.workspace_id,run.id]);
      await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'submitting')",[run.workspace_id,run.id]);return true;
    });
    if(!claimed)return;
    let attempted=false;
    try{
      const assets=(await this.pool.query("SELECT a.storage_key,a.content_type,a.bytes,i.role FROM run_inputs i JOIN assets a ON a.workspace_id=i.workspace_id AND a.id=i.asset_id WHERE i.workspace_id=$1 AND i.run_id=$2",[run.workspace_id,run.id])).rows;
      const owned:OwnedInput[]=assets.map(a=>({role:a.role,contentType:a.content_type,bytes:Number(a.bytes),open:()=>this.store.read(run.workspace_id,a.storage_key)}));
      const prepared=await entry.adapter.prepareInputs(owned,context);
      if(await this.state(run)==="cancel_requested"){await this.transition(run,"canceled");return;}
      await this.credential(run);
      const canSubmit=await transaction(this.pool,async client=>{
        const current=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[run.workspace_id,run.id])).rows[0];
        if(current?.state!=="submitting")return false;
        await client.query("UPDATE provider_run_bindings SET phase='submit_started' WHERE workspace_id=$1 AND run_id=$2",[run.workspace_id,run.id]);return true;
      });
      if(!canSubmit){if(await this.state(run)==="cancel_requested")await this.transition(run,"canceled");return;}
      attempted=true;
      const result=await entry.adapter.submit(structuredClone(run.invocation),prepared,context);
      if(result?.kind==="rejected"){await this.transition(run,"failed","Provider rejected generation.");return;}
      if(result?.kind!=="accepted"||!remoteId(result.remoteId)){await this.transition(run,"submission_unknown",messages.unknown);await this.dueLater(run);return;}
      await this.transition(run,"queued",null,result.remoteId);
      await this.pool.query("UPDATE provider_run_bindings SET phase='accepted' WHERE workspace_id=$1 AND run_id=$2",[run.workspace_id,run.id]);
      await this.dueLater(run);
    }catch{
      if(attempted){await this.transition(run,"submission_unknown",messages.unknown);await this.dueLater(run);}
      else await this.transition(run,await this.state(run)==="cancel_requested"?"canceled":"failed","Provider input preparation failed before generation.");
    }
  }
  private async ingest(run:any,entry:RegisteredAdapter,context:AdapterContext){
    const saved:Array<{id:string;key:string;sha256:string;bytes:number;mediaType?:string;contentType?:string;metadata?:Record<string,unknown>}>=[];
    try{
      const outputs=await entry.adapter.outputs(run.remote_id,context);
      if(!Array.isArray(outputs)||!outputs.length||outputs.length>8)throw new Error("Invalid outputs");
      for(const output of outputs){
        if(!['video','image'].includes(output.mediaType)||!run.manifest.outputs.some((p:any)=>p.type===output.mediaType)||typeof output.url!=="string")throw new Error("Invalid output");
        const download=await context.transport.artifact(output.url,this.store.maxBytes);
        const asset={id:newId(),...await this.store.put(run.workspace_id,download.body)};saved.push(asset);
        const path=await this.store.file(run.workspace_id,asset.key);
        if(output.mediaType==='image'){
          const image=sharp(path,{limitInputPixels:4096*4096}),metadata=await image.metadata();
          if(!['png','jpeg','webp'].includes(metadata.format??'')||!metadata.width||!metadata.height)throw new Error('Invalid image');
          await image.stats();Object.assign(saved[saved.length-1],{mediaType:'image',contentType:`image/${metadata.format}`,metadata:{width:metadata.width,height:metadata.height}});
        }else{
          const metadata=await probeVideo(path);
          if(!metadata.container?.match(/mov|mp4|webm/)||run.invocation.audioPolicy==="mute"&&metadata.hasAudio)throw new Error("Invalid encoded output");
          Object.assign(saved[saved.length-1],{mediaType:'video',contentType:metadata.container.includes('webm')?'video/webm':'video/mp4',metadata});
        }
      }
      await transaction(this.pool,async client=>{
        const current=(await client.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[run.workspace_id,run.id])).rows[0];
        if(!current||terminal(current.state))throw new Error("Run already finished");
        for(const [index,asset] of saved.entries())await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[asset.id,run.workspace_id,run.project_id,`provider-${asset.mediaType}-${index+1}`,asset.mediaType,asset.contentType,asset.key,asset.sha256,asset.bytes,run.created_by,JSON.stringify(asset.metadata)]);
        await client.query("UPDATE runs SET state='succeeded',output_ids=$1,error=NULL,updated_at=now() WHERE workspace_id=$2 AND id=$3",[JSON.stringify(saved.map(a=>a.id)),run.workspace_id,run.id]);
        await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'succeeded')",[run.workspace_id,run.id]);
      });
    }catch{
      // COMMIT acknowledgement may be lost. Never delete potentially published files.
      for(const asset of saved){try{if(!(await this.pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[run.workspace_id,asset.id])).rowCount)await this.store.remove(run.workspace_id,asset.key);}catch{/* Preserve candidate if database confirmation is unavailable. */}}
      await this.defer(run,messages.output);
    }
  }
}
