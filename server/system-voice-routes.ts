import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {Readable} from "node:stream";
import {createHash} from "node:crypto";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {transaction} from "./db";
import type {DiskStore} from "./storage";
import {voiceWav} from "./voice-wav";
import {windowsSystemVoice,type SystemVoiceEngine} from "./system-voice";
import {makeSpeechPlayback} from "./speech-playback";
export const systemVoiceBody=z.object({requestId:z.uuid(),text:z.string().trim().min(1).max(400),voice:z.string().min(1).max(200),delivery:z.enum(["natural","calm","brisk"])}).strict();
export const systemVoiceRates={natural:0,calm:-2,brisk:2} as const;
const columns="id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata",base="/api/v1/workspaces/:workspaceId/projects/:projectId/system-voice",params=z.object({workspaceId:z.uuid(),projectId:z.uuid()});
export async function systemVoiceRoutes(app:FastifyInstance,pool:Pool,store:DiskStore,engine:SystemVoiceEngine=windowsSystemVoice){
  app.get(base,async request=>{const {workspaceId,projectId}=params.parse(request.params);await member(pool,request,workspaceId);if(!(await pool.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rowCount)throw new HttpError(404,"Project not found.");try{return {voices:await engine.voices()};}catch{return {voices:[]};}});
  app.post(base,async request=>{
    const {workspaceId,projectId}=params.parse(request.params),user=await member(pool,request,workspaceId,"creator");z.object({}).strict().parse(request.query);const body=systemVoiceBody.parse(request.body),requestHash=createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}:${body.requestId}`]);
      const existing=(await client.query(`SELECT ${columns},created_by FROM assets WHERE workspace_id=$1 AND id=$2`,[workspaceId,body.requestId])).rows[0];
      if(existing){if(existing.project_id!==projectId||existing.created_by!==user.id||existing.metadata?.systemVoice?.requestHash!==requestHash)throw new HttpError(409,"This voice identifier belongs to another request.");const {created_by,...asset}=existing;return asset;}
      if(!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rowCount)throw new HttpError(404,"Project not found.");
      const voices=await engine.voices();if(!voices.some(v=>v.name===body.voice))throw new HttpError(422,"Choose an installed local voice or record a take instead.");
      const rate=systemVoiceRates[body.delivery],rendered=await engine.synthesize({text:body.text,voice:body.voice,rate},store.root),{bytes,marks,visemes}=rendered,facts=voiceWav(bytes),playback=makeSpeechPlayback(bytes,body.text,marks,visemes),saved=await store.put(workspaceId,Readable.from(bytes));let inserting=false;
      try{const metadata={...facts,systemVoice:{version:1,engine:"windows-system-speech",voice:body.voice,culture:voices.find(v=>v.name===body.voice)!.culture,rate,delivery:body.delivery,text:body.text,requestHash,createdBy:user.id,playback}};inserting=true;
        return (await client.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,'Local voice take','audio','audio/wav',$4,$5,$6,$7,$8) RETURNING ${columns}`,[body.requestId,workspaceId,projectId,saved.key,saved.sha256,saved.bytes,user.id,JSON.stringify(metadata)])).rows[0];
      }catch(error){if(!inserting)await store.remove(workspaceId,saved.key).catch(()=>{});throw error;}
    });
  });
}
