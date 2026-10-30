import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {newId,hashToken} from "./crypto";
import {transaction} from "./db";
import type {DiskStore} from "./storage";
import {microphoneWav,MAX_MICROPHONE_BYTES} from "./microphone-wav";

const base="/api/v1/workspaces/:workspaceId/projects/:projectId/microphone-takes";
const params=z.object({workspaceId:z.uuid(),projectId:z.uuid()});
export async function microphoneRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  app.get(base,async request=>{const {workspaceId,projectId}=params.parse(request.params);await member(pool,request,workspaceId);return (await pool.query("SELECT id,asset_id,record,created_at FROM microphone_takes WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50",[workspaceId,projectId])).rows;});
  app.post(base,async request=>{
    const {workspaceId,projectId}=params.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const {idempotencyKey}=z.object({idempotencyKey:z.uuid(),consent:z.literal("true")}).strict().parse(request.query);
    if(!(await pool.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rowCount)throw new HttpError(404,"Project not found");
    let script="",saved:Awaited<ReturnType<DiskStore["put"]>>|undefined,attempted=false;
    const id=newId(),assetId=newId();
    const lookup=async()=> (await pool.query("SELECT id,asset_id,record,request_hash FROM microphone_takes WHERE workspace_id=$1 AND project_id=$2 AND created_by=$3 AND idempotency_key=$4",[workspaceId,projectId,user.id,idempotencyKey])).rows[0];
    try{
      for await(const part of request.parts({limits:{files:1,fields:1,parts:2,fileSize:MAX_MICROPHONE_BYTES,fieldSize:16000}})){
        if(part.type==="field"){
          if(part.fieldname!=="script"||part.valueTruncated||typeof part.value!=="string"||part.value.length>4000)throw new HttpError(400,"Keep the table-read text within 4000 characters.");script=part.value.replace(/\r\n?/g,"\n");
        }else{
          if(!["audio/wav","audio/x-wav"].includes(part.mimetype)){part.file.resume();throw new HttpError(415,"Upload a microphone WAV take.");}
          saved=await store.put(workspaceId,part.file);if(part.file.truncated)throw new HttpError(413,"The recording exceeds 60 seconds.");
        }
      }
      if(!saved)throw new HttpError(400,"Record a microphone take first.");
      const facts=microphoneWav(await readFile(await store.file(workspaceId,saved.key))),hash=hashToken(JSON.stringify({sha256:saved.sha256,script,consent:true}));
      const record={schema:"comfyfield/microphone-take-v1",sourceType:"recorded",...facts,script,sha256:saved.sha256,consent:{microphone:true,attestedAt:new Date().toISOString(),attestedBy:user.id},capture:"browser-mono-pcm16"};
      attempted=true;const result=await transaction(pool,async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`microphone/${workspaceId}/${projectId}/${user.id}/${idempotencyKey}`]);
        const old=(await client.query("SELECT id,asset_id,record,request_hash FROM microphone_takes WHERE workspace_id=$1 AND project_id=$2 AND created_by=$3 AND idempotency_key=$4",[workspaceId,projectId,user.id,idempotencyKey])).rows[0];
        if(old){if(old.request_hash!==hash)throw new HttpError(409,"This recording request already contains a different take.");return {...old,repeated:true};}
        await client.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,$4,'audio','audio/wav',$5,$6,$7,$8,$9)",[assetId,workspaceId,projectId,`microphone-${id}.wav`,saved!.key,saved!.sha256,saved!.bytes,user.id,JSON.stringify({microphoneTake:record})]);
        return {...(await client.query("INSERT INTO microphone_takes(id,workspace_id,project_id,created_by,idempotency_key,request_hash,asset_id,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,asset_id,record,created_at",[id,workspaceId,projectId,user.id,idempotencyKey,hash,assetId,JSON.stringify(record)])).rows[0],repeated:false};
      });
      if(result.repeated)await store.remove(workspaceId,saved.key);delete result.request_hash;return result;
    }catch(error){
      if(saved){
        if(!attempted)await store.remove(workspaceId,saved.key).catch(()=>{});
        else {const durable=await lookup().catch(()=>undefined);if(durable?.asset_id===assetId)return {id:durable.id,asset_id:durable.asset_id,record:durable.record,repeated:false};if(durable!==undefined)await store.remove(workspaceId,saved.key).catch(()=>{});else{const absent=await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,assetId]).then(r=>!r.rowCount).catch(()=>false);if(absent)await store.remove(workspaceId,saved.key).catch(()=>{});}}
      }
      throw error;
    }
  });
}
