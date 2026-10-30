import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { member, HttpError } from "./auth";
import { transaction } from "./db";
import { newId, hashToken } from "./crypto";
import type { DiskStore } from "./storage";
import {createReadStream} from "node:fs";
import {readFile,stat} from "node:fs/promises";
import {byteRange} from "./range";
import {generationSchema} from "./storyboard-execution";
import {DEFAULT_PNG_VALIDATION_LIMITS,PngValidationError,validatePngBytes} from "./image-artifacts-validation";
import {sanitizedImageProvenance,sanitizedRelationMetadata} from "./image-artifacts";
import {elementInputsSchema} from "./element-inputs";
import {deleteLibraryAsset} from "./asset-deletion";
import {inspectGlb} from "../src/team/three-d/glb-document";
import {deleteRun} from "./runs";

const base = "/api/v1/workspaces/:workspaceId";
const ws = z.object({ workspaceId: z.uuid() });
const item = ws.extend({ id: z.uuid() });
const name = z.string().trim().min(1).max(120);
const text = z.string().max(20000);
const assetColumns = "id,project_id,name,media_type,content_type,sha256,bytes,parent_id,created_at,metadata";
const refs = z.array(z.uuid()).max(16).refine(a => new Set(a).size === a.length, "Duplicate reference");
/* A worker saves results under its own names (`Flux2-Klein_00032_.png`, `image-1792885667649.webp`).
   Those are number soup in a download folder, so a saved file is named after its project, the
   workflow that made it and the minute it was made, unless the stored name already reads well. */
const poorName = /[\\/]|_\d{3,}_|\d{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/i;
const extensions: Record<string,string> = {"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/ogg":"ogg","audio/mp4":"m4a","audio/flac":"flac","model/gltf-binary":"glb"};
const slug = (value:string) => value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu,"-").replace(/^-+|-+$/g,"").slice(0,48);
const asciiSlug = (value:string) => slug(value.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x20-\x7e]+/g," "));
const stamp = (when:Date) => { const iso=when.toISOString(); return `${iso.slice(0,10)}-${iso.slice(11,16).replace(":","")}`; };
export function downloadName(asset:{name:string;content_type?:string|null;created_at:Date},projectName?:string|null,madeBy?:string|null){
  if(asset.name&&!poorName.test(asset.name))return {utf8:asset.name,ascii:asset.name.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x20-\x7e]+/g,"-")};
  const dot=asset.name?.lastIndexOf(".")??-1;
  const extension=(dot>0?asset.name.slice(dot+1).toLowerCase().replace(/[^a-z0-9]/g,""):"")||extensions[asset.content_type??""]||"";
  const when=stamp(asset.created_at);
  const maker=asciiSlug(madeBy??"")||"upload";
  return {utf8:`${slug(projectName??"")||"comfyfield"}-${maker}-${when}${extension?`.${extension}`:""}`,ascii:`${asciiSlug(projectName??"")||"comfyfield"}-${maker}-${when}${extension?`.${extension}`:""}`};
}
export function dispositionHeader(kind:"attachment"|"inline",name:{ascii:string;utf8:string}){
  const encoded=encodeURIComponent(name.utf8).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${name.ascii.replace(/["\\]/g,c=>`\\${c}`)}"; filename*=UTF-8''${encoded}`;
}
async function ownedAssets(client: PoolClient, workspaceId: string, ids: string[]) {
  if (!ids.length) return;
  const result = await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [workspaceId,ids]);
  if (result.rows.length !== new Set(ids).size) throw new HttpError(404, "Reference asset not found in this workspace");
}

export async function resourceRoutes(app: FastifyInstance, pool: Pool, store: DiskStore) {
  app.get(`${base}/projects`, async request => {
    const { workspaceId } = ws.parse(request.params); await member(pool,request,workspaceId);
    return (await pool.query("SELECT id,name,description,created_at,updated_at FROM projects WHERE workspace_id=$1 ORDER BY updated_at DESC", [workspaceId])).rows;
  });
  app.post(`${base}/projects`, async request => {
    const { workspaceId } = ws.parse(request.params), user = await member(pool,request,workspaceId,"creator");
    const body = z.object({ name, description: text.default("") }).strict().parse(request.body);
    return (await pool.query("INSERT INTO projects(id,workspace_id,name,description,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,description,created_at", [newId(),workspaceId,body.name,body.description,user.id])).rows[0];
  });
  app.patch(`${base}/projects/:id`, async request => {
    const { workspaceId,id } = item.parse(request.params); await member(pool,request,workspaceId,"creator");
    const body = z.object({ name, description: text.default("") }).strict().parse(request.body);
    const result = await pool.query("UPDATE projects SET name=$1,description=$2,updated_at=now() WHERE workspace_id=$3 AND id=$4 RETURNING id,name,description", [body.name,body.description,workspaceId,id]);
    if (!result.rowCount) throw new HttpError(404,"Project not found"); return result.rows[0];
  });
  app.delete(`${base}/projects/:id`, async request => {
    const { workspaceId,id } = item.parse(request.params); await member(pool,request,workspaceId,"creator");
    const count = await pool.query("SELECT (SELECT count(*) FROM assets WHERE workspace_id=$1 AND project_id=$2)+(SELECT count(*) FROM runs WHERE workspace_id=$1 AND project_id=$2)+(SELECT count(*) FROM storyboards WHERE workspace_id=$1 AND project_id=$2)+(SELECT count(*) FROM character_records WHERE workspace_id=$1 AND project_id=$2)+(SELECT count(*) FROM marketing_products WHERE workspace_id=$1 AND project_id=$2)+(SELECT count(*) FROM editor_documents WHERE workspace_id=$1 AND project_id=$2)+(SELECT count(*) FROM asset_deletions WHERE workspace_id=$1 AND project_id=$2 AND completed_at IS NULL) AS n", [workspaceId,id]);
    if (Number(count.rows[0].n)) throw new HttpError(409,"Project contains assets, unfinished file cleanup, storyboards, runs, characters or marketing records; preserve or move these records first");
    await transaction(pool, async client => {
      await client.query("DELETE FROM legacy_project_members WHERE workspace_id=$1 AND project_id=$2",[workspaceId,id]);
      await client.query("DELETE FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);
    }); return { removed: true };
  });

  app.get(`${base}/assets`, async request => {
    const { workspaceId } = ws.parse(request.params); const user=await member(pool,request,workspaceId);
    const query = z.object({ projectId: z.uuid().optional(),kind:z.enum(["image","video","audio","mask","layer","reference","model3d"]).optional(),includeDocumentBitmaps:z.enum(["true","false"]).default("false").transform(v=>v==="true"), cursor:z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().parse(request.query);
    let cursor:[string,string]|undefined;
    if(query.cursor)try {cursor=z.tuple([z.iso.datetime(),z.uuid()]).parse(JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")));}catch{throw new HttpError(400,"Invalid asset cursor");}
    const rows=(await pool.query(`SELECT ${assetColumns},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM assets WHERE workspace_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) AND ($6::text IS NULL OR media_type=$6) AND ($7::boolean OR metadata->>'editorDocumentBitmap' IS DISTINCT FROM 'true') AND NOT (metadata ? 'posePreviewFrame' OR metadata ? 'posePreview') ORDER BY created_at DESC,id DESC LIMIT $5`, [workspaceId,query.projectId ?? null,cursor?.[0]??null,cursor?.[1]??null,query.limit+1,query.kind??null,query.includeDocumentBitmaps])).rows;
    const more=rows.length>query.limit,items=rows.slice(0,query.limit),last=items.at(-1);
    const nextCursor=more&&last?Buffer.from(JSON.stringify([last.cursor_time,last.id])).toString("base64url"):null;
    for(const row of items)delete row.cursor_time;
    const pendingDeletion=user.role!=="viewer"?(await pool.query("SELECT asset_id AS id,name FROM asset_deletions WHERE workspace_id=$1 AND ($2::uuid IS NULL OR project_id=$2) AND completed_at IS NULL ORDER BY created_at,asset_id LIMIT 1",[workspaceId,query.projectId??null])).rows[0]:undefined;
    return {items,nextCursor,...(pendingDeletion?{pendingDeletion}:{})};
  });
  app.get(`${base}/assets/:id`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId);
    const asset=(await pool.query(`SELECT ${assetColumns} FROM assets WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
    if(!asset)throw new HttpError(404,"Asset not found");
    const relations=(await pool.query("SELECT related_asset_id AS asset_id,role,ordinal,metadata FROM asset_relations WHERE workspace_id=$1 AND asset_id=$2 ORDER BY role,ordinal",[workspaceId,id])).rows.map(relation=>({...relation,metadata:sanitizedRelationMetadata(relation.metadata)}));
    return {...asset,relations,provenance:sanitizedImageProvenance(asset.metadata)};
  });
  app.post(`${base}/assets`, async request => {
    const { workspaceId } = ws.parse(request.params), user = await member(pool,request,workspaceId,"creator");
    const query = z.object({ projectId: z.uuid().optional(), parentId: z.uuid().optional(), kind: z.enum(["image","video","audio","mask","layer","reference","model3d"]).optional(),purpose:z.literal("editor-document").optional() }).strict().parse(request.query);
    if(query.purpose&&query.kind!=="layer")throw new HttpError(400,"Editor document pixels must be uploaded as PNG layers.");
    if (query.projectId && !(await pool.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,query.projectId])).rowCount) throw new HttpError(404,"Project not found");
    const file = await request.file();
    if (!file) throw new HttpError(400,"Choose a media file");
    const allowed: Record<string,string> = { "image/png":"image", "image/jpeg":"image", "image/webp":"image", "image/gif":"image", "video/mp4":"video", "video/webm":"video", "video/quicktime":"video", "audio/mpeg":"audio", "audio/wav":"audio", "audio/x-wav":"audio", "audio/ogg":"audio", "audio/mp4":"audio", "audio/flac":"audio", "model/gltf-binary":"model3d" };
    const inferred = allowed[file.mimetype];
    if (!inferred) { file.file.resume(); throw new HttpError(415,"Upload a supported raster image, video, audio or GLB model"); }
    const mediaType = query.kind ?? inferred;
    if (["mask","layer","reference"].includes(mediaType) ? inferred !== "image" : mediaType !== inferred) { file.file.resume(); throw new HttpError(400,"Media kind does not match file type"); }
    if (["mask","layer"].includes(mediaType)&&file.mimetype!=="image/png") { file.file.resume(); throw new HttpError(415,"Image masks and layers must be PNG files"); }
    const saved = await store.put(workspaceId, file.file);
    const id=newId();let inserting=false;
    try {
      if (file.file.truncated) throw new HttpError(413,"Upload exceeds configured limit");
      let metadata:Record<string,unknown>=query.purpose?{editorDocumentBitmap:true}:{};
      if(mediaType==="model3d"){if(saved.bytes>64*1024*1024)throw new HttpError(413,"GLB models must be smaller than 64 MB.");try{inspectGlb(await readFile(await store.file(workspaceId,saved.key)));metadata={format:"glb",version:2,bytes:saved.bytes};}catch(error){throw new HttpError(422,(error as Error).message);}}
      if(file.mimetype==="image/png"&&["image","mask","layer"].includes(mediaType)){
        if(saved.bytes>DEFAULT_PNG_VALIDATION_LIMITS.maxBytes)throw new HttpError(413,"The PNG file exceeds the allowed byte size");
        try{
          const validated=await validatePngBytes(await readFile(await store.file(workspaceId,saved.key)));
          metadata={...metadata,imageValidation:{validationVersion:1,format:"png",width:validated.width,height:validated.height,hasAlpha:validated.hasAlpha,semantic:mediaType}};
        }catch(error){
          if(error instanceof PngValidationError)throw new HttpError(error.code==="input_too_large"?413:422,error.message);
          throw error;
        }
      }
      inserting=true;
      return await transaction(pool,async client=>{
        if(query.parentId){
          const parent=await client.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id IS NOT DISTINCT FROM $3::uuid FOR SHARE",[workspaceId,query.parentId,query.projectId??null]);
          if(!parent.rowCount)throw new HttpError(404,"Parent asset not found in this project");
        }
        const row=(await client.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,parent_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${assetColumns}`, [id,workspaceId,query.projectId ?? null,file.filename.slice(0,240),mediaType,file.mimetype,saved.key,saved.sha256,saved.bytes,user.id,query.parentId ?? null,JSON.stringify(metadata)])).rows[0];
        if(query.parentId&&query.projectId&&["image","mask","layer"].includes(mediaType))await client.query("INSERT INTO asset_relations(workspace_id,project_id,asset_id,related_asset_id,role,ordinal) VALUES($1,$2,$3,$4,'parent',0)",[workspaceId,query.projectId,id,query.parentId]);
        return row;
      });
    } catch(error) {
      if(inserting){
        // COMMIT acknowledgement can be lost. A deterministic ID lets us
        // recover the committed row; an unavailable database is ambiguity, so
        // retain the bytes for later reconciliation instead of deleting them.
        const durable=await pool.query(`SELECT ${assetColumns},storage_key FROM assets WHERE workspace_id=$1 AND id=$2`,[workspaceId,id]).then(result=>result.rows[0]).catch(()=>undefined);
        if(durable?.storage_key===saved.key&&durable.sha256===saved.sha256){delete durable.storage_key;return durable;}
        if(durable===null)await store.remove(workspaceId,saved.key).catch(()=>{});
        else if(durable===undefined){
          const confirmedAbsent=await pool.query("SELECT id FROM assets WHERE workspace_id=$1 AND id=$2",[workspaceId,id]).then(result=>!result.rowCount).catch(()=>false);
          if(confirmedAbsent)await store.remove(workspaceId,saved.key).catch(()=>{});
        }
      }else await store.remove(workspaceId,saved.key).catch(()=>{});
      throw error;
    }
  });
  app.get(`${base}/assets/:id/content`, async (request,reply) => {
    const { workspaceId,id } = item.parse(request.params); await member(pool,request,workspaceId);
    const asset = (await pool.query(`SELECT a.storage_key,a.name,a.content_type,a.bytes,a.created_at,p.name AS project_name,
      (SELECT COALESCE(v.manifest->>'title',r.capability_id) FROM runs r LEFT JOIN workflow_revisions v ON v.workspace_id=r.workspace_id AND v.id=r.workflow_revision_id
        WHERE r.workspace_id=a.workspace_id AND r.output_ids @> jsonb_build_array(a.id::text) ORDER BY r.created_at DESC LIMIT 1) AS made_by
      FROM assets a LEFT JOIN projects p ON p.workspace_id=a.workspace_id AND p.id=a.project_id WHERE a.workspace_id=$1 AND a.id=$2`,[workspaceId,id])).rows[0];
    if (!asset) throw new HttpError(404,"Asset not found");
    const file=await store.file(workspaceId,asset.storage_key),size=(await stat(file)).size;
    const range=byteRange(request.headers.range,size);
    const download=z.object({download:z.enum(["1"]).optional()}).strict().parse(request.query).download;
    reply.header("Content-Type",asset.content_type).header("Accept-Ranges","bytes").header("Content-Disposition",dispositionHeader(download?"attachment":"inline",downloadName(asset,asset.project_name,asset.made_by)));
    if(range==="invalid")return reply.code(416).header("Content-Range",`bytes */${size}`).send();
    if(range){reply.code(206).header("Content-Range",`bytes ${range.start}-${range.end}/${size}`).header("Content-Length",range.end-range.start+1);}
    else reply.header("Content-Length",size);
    return reply.send(createReadStream(file,range??undefined));
  });
  app.delete(`${base}/assets/:id`, async request => {
    const { workspaceId,id } = item.parse(request.params); await member(pool,request,workspaceId,"creator");
    return deleteLibraryAsset(pool,store,workspaceId,id);
  });
  /* A finished or failed result can leave the results. Its record stays as history, its own outputs
     leave the library unless another run or a storyboard still uses them. */
  app.delete(`${base}/runs/:id`, async (request,reply) => {
    const { workspaceId,id } = item.parse(request.params); const user=await member(pool,request,workspaceId,"creator");
    await deleteRun(pool,store,workspaceId,id,user);
    return reply.code(204).send();
  });

  app.get(`${base}/elements`, async request => {
    const { workspaceId } = ws.parse(request.params); await member(pool,request,workspaceId);
    const {projectId}=z.object({projectId:z.uuid().optional()}).strict().parse(request.query);
    if(projectId&&!(await pool.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rowCount)throw new HttpError(404,"Project not found");
    return (await pool.query(`SELECT e.id,e.name,e.kind,e.description,e.created_at,
      COALESCE(array_agg(a.id ORDER BY ea.asset_id) FILTER(WHERE a.id IS NOT NULL),'{}') AS asset_ids,
      COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'project_id',a.project_id,'name',a.name,'media_type',a.media_type,'content_type',a.content_type,'sha256',a.sha256,'bytes',a.bytes,'parent_id',a.parent_id,'created_at',a.created_at,'metadata',a.metadata) ORDER BY ea.asset_id) FILTER(WHERE a.id IS NOT NULL),'[]') AS assets
      FROM elements e LEFT JOIN element_assets ea ON ea.workspace_id=e.workspace_id AND ea.element_id=e.id
      LEFT JOIN assets a ON a.workspace_id=ea.workspace_id AND a.id=ea.asset_id AND ($2::uuid IS NULL OR a.project_id=$2 OR a.project_id IS NULL)
      WHERE e.workspace_id=$1 GROUP BY e.id ORDER BY e.created_at DESC`,[workspaceId,projectId??null])).rows;
  });
  app.post(`${base}/elements`, async request => {
    const { workspaceId } = ws.parse(request.params), user = await member(pool,request,workspaceId,"creator");
    const body = z.object({ name, kind:z.enum(["character","product","environment","voice","style"]),description:text.default(""),assetIds:refs.default([]) }).strict().parse(request.body);
    return transaction(pool, async client => {
      await ownedAssets(client,workspaceId,body.assetIds); const id=newId();
      await client.query("INSERT INTO elements(id,workspace_id,name,kind,description,created_by) VALUES($1,$2,$3,$4,$5,$6)",[id,workspaceId,body.name,body.kind,body.description,user.id]);
      for(const assetId of body.assetIds) await client.query("INSERT INTO element_assets(workspace_id,element_id,asset_id) VALUES($1,$2,$3)",[workspaceId,id,assetId]);
      return { id,...body };
    });
  });
  const shot = z.object({ planKey:z.uuid().optional(), prompt:text, durationSeconds:z.number().positive().max(120), settings:z.object({ title:z.string().max(500).optional(), generation:generationSchema.optional(), capabilityId:z.string().max(120).optional(),cameraHint:z.string().max(500).optional(),audioPolicy:z.enum(["preserve","replace","mix","mute"]).default("mute"),elementInputs:elementInputsSchema.default({}) }).strict().default({audioPolicy:"mute",elementInputs:{}}), assets:z.array(z.object({role:z.enum(["start_image","end_image","motion_video","reference","mask","audio"]),assetId:z.uuid()}).strict()).max(16).default([]) }).strict();
  app.get(`${base}/storyboards`, async request => {
    const { workspaceId }=ws.parse(request.params); await member(pool,request,workspaceId);
    return (await pool.query("SELECT id,project_id,name,revision,created_at FROM storyboards WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at DESC",[workspaceId])).rows;
  });
  app.post(`${base}/storyboards`, async request => {
    const { workspaceId }=ws.parse(request.params), user=await member(pool,request,workspaceId,"creator");
    const body=z.object({ name,projectId:z.uuid() }).strict().parse(request.body);
    return (await pool.query("INSERT INTO storyboards(id,workspace_id,project_id,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,project_id,revision",[newId(),workspaceId,body.projectId,body.name,user.id])).rows[0];
  });
  /* A board can be created and never removed, so abandoned ones pile up in the picker. Renders and
     stills are the record of what was produced, so removal archives the board instead of deleting it. */
  app.delete(`${base}/storyboards/:id`,async request=>{
    const { workspaceId,id }=item.parse(request.params); await member(pool,request,workspaceId,"creator");
    const updated=await pool.query("UPDATE storyboards SET archived_at=now() WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id",[workspaceId,id]);
    if(!updated.rowCount) throw new HttpError(404,"Storyboard not found");
    return { archived:id };
  });
  app.get(`${base}/storyboards/:id`,async request=>{
    const { workspaceId,id }=item.parse(request.params); await member(pool,request,workspaceId);
    const board=(await pool.query("SELECT id,name,project_id,revision FROM storyboards WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rows[0];
    if(!board) throw new HttpError(404,"Storyboard not found");
    const shots=(await pool.query("SELECT s.id,s.plan_key,s.ordinal,s.prompt,s.duration_seconds,s.settings,COALESCE(jsonb_agg(jsonb_build_object('role',a.role,'assetId',a.asset_id)) FILTER(WHERE a.asset_id IS NOT NULL),'[]') AS assets FROM shots s LEFT JOIN shot_assets a ON a.workspace_id=s.workspace_id AND a.shot_id=s.id WHERE s.workspace_id=$1 AND s.storyboard_id=$2 GROUP BY s.id ORDER BY s.ordinal",[workspaceId,id])).rows;
    return {...board,shots};
  });
  app.put(`${base}/storyboards/:id/shots`,async request=>{
    const { workspaceId,id }=item.parse(request.params); await member(pool,request,workspaceId,"creator");
    const body=z.object({ revision:z.number().int().positive(),shots:z.array(shot).max(100) }).strict().parse(request.body);
    return transaction(pool,async client=>{
      const board=(await client.query("SELECT revision,project_id FROM storyboards WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
      if(!board) throw new HttpError(404,"Storyboard not found");
      if(board.revision!==body.revision) throw new HttpError(409,"Storyboard changed; reload before saving");
      const previous=(await client.query("SELECT ordinal,plan_key FROM shots WHERE workspace_id=$1 AND storyboard_id=$2",[workspaceId,id])).rows;
      const planKeys=body.shots.map((s,i)=>s.planKey??previous.find(p=>p.ordinal===i)?.plan_key??newId());
      if(new Set(planKeys).size!==planKeys.length)throw new HttpError(400,"Duplicate shot plan identity");
      await ownedAssets(client,workspaceId,body.shots.flatMap(s=>s.assets.map(a=>a.assetId)));
      const elementPairs=[...new Map(body.shots.flatMap(s=>Object.values(s.settings.elementInputs)).map(binding=>[`${binding.elementId}:${binding.assetId}`,binding])).values()];
      if(elementPairs.length){
        const found=(await client.query(`SELECT e.id AS element_id,a.id AS asset_id FROM elements e JOIN element_assets ea ON ea.workspace_id=e.workspace_id AND ea.element_id=e.id JOIN assets a ON a.workspace_id=ea.workspace_id AND a.id=ea.asset_id WHERE e.workspace_id=$1 AND (a.project_id=$2 OR a.project_id IS NULL) AND e.id=ANY($3::uuid[]) AND a.id=ANY($4::uuid[])`,[workspaceId,board.project_id,elementPairs.map(binding=>binding.elementId),elementPairs.map(binding=>binding.assetId)])).rows;
        const available=new Set(found.map(row=>`${row.element_id}:${row.asset_id}`));if(elementPairs.some(binding=>!available.has(`${binding.elementId}:${binding.assetId}`)))throw new HttpError(404,"Storyboard Element asset not found");
      }
      for(const s of body.shots){if(new Set(s.assets.map(a=>a.role)).size!==s.assets.length)throw new HttpError(400,"Duplicate shot input role");if(s.assets.some(a=>Object.hasOwn(s.settings.elementInputs,a.role)))throw new HttpError(400,"Shot input cannot use both direct media and an Element asset");}
      await client.query("DELETE FROM shot_assets WHERE workspace_id=$1 AND shot_id IN (SELECT id FROM shots WHERE workspace_id=$1 AND storyboard_id=$2)",[workspaceId,id]);
      await client.query("DELETE FROM shots WHERE workspace_id=$1 AND storyboard_id=$2",[workspaceId,id]);
      for(const [ordinal,s] of body.shots.entries()) {
        const shotId=newId();
        await client.query("INSERT INTO shots(id,workspace_id,storyboard_id,ordinal,prompt,duration_seconds,settings,plan_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[shotId,workspaceId,id,ordinal,s.prompt,s.durationSeconds,JSON.stringify(s.settings),planKeys[ordinal]]);
        for(const a of s.assets) await client.query("INSERT INTO shot_assets(workspace_id,shot_id,asset_id,role) VALUES($1,$2,$3,$4)",[workspaceId,shotId,a.assetId,a.role]);
      }
      await client.query("UPDATE storyboards SET revision=revision+1 WHERE workspace_id=$1 AND id=$2",[workspaceId,id]);
      return { revision:board.revision+1,shots:body.shots.length };
    });
  });
  app.post(`${base}/imports/browser-projects`,async request=>{
    const { workspaceId }=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator");
    const body=z.object({sourceId:z.string().min(1).max(200),scope:z.string().max(300),projects:z.array(z.object({name,promptIds:z.array(z.string().min(1).max(200)).max(2000)}).strict()).max(100)}).strict().parse(request.body);
    const hash=hashToken(JSON.stringify(body));
    return transaction(pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}/${body.sourceId}`]);
      const previous=(await client.query("SELECT payload_hash,result FROM imports WHERE workspace_id=$1 AND source_id=$2",[workspaceId,body.sourceId])).rows[0];
      if(previous) { if(previous.payload_hash!==hash) throw new HttpError(409,"Import ID already used for different data"); return {...previous.result,repeated:true}; }
      const projectIds:string[]=[];
      for(const p of body.projects) {
        const id=newId(); projectIds.push(id);
        await client.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,$3,$4)",[id,workspaceId,p.name,user.id]);
        for(const promptId of new Set(p.promptIds)) await client.query("INSERT INTO legacy_project_members(workspace_id,project_id,prompt_id,source_scope) VALUES($1,$2,$3,$4)",[workspaceId,id,promptId,body.scope]);
      }
      const result={projectIds,mediaImported:false,sourcePreserved:true};
      await client.query("INSERT INTO imports(workspace_id,source_id,payload_hash,result) VALUES($1,$2,$3,$4)",[workspaceId,body.sourceId,hash,JSON.stringify(result)]);
      return result;
    });
  });
}
