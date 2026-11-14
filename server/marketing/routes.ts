import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { HttpError, member } from "../auth";
import { newId } from "../crypto";
import { transaction } from "../db";
import type { DiskStore } from "../storage";
import { brandInput, brandPatch, briefInput, briefPatch, formatSpec, marketingFormats, productInput, productPatch, renderInput } from "./contracts";
import { checkMarketingRenderer, MARKETING_RENDERER } from "./renderer";
import { MarketingRenderService, publicVariant } from "./service";

const base="/api/v1/workspaces/:workspaceId/marketing";
const ws=z.object({workspaceId:z.uuid()});
const item=ws.extend({id:z.uuid()});
const projectQuery=z.object({projectId:z.uuid()}).strict();
function brand(row:Record<string,unknown>){return {id:row.id,name:row.name,primaryColor:row.primary_color,backgroundColor:row.background_color,textColor:row.text_color,logoAssetId:row.logo_asset_id??null,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at};}
function product(row:Record<string,unknown>){return {id:row.id,projectId:row.project_id,name:row.name,description:row.description,imageAssetId:row.image_asset_id,additionalAssetIds:row.additional_asset_ids??[],revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at};}
function brief(row:Record<string,unknown>){return {id:row.id,projectId:row.project_id,brandKitId:row.brand_kit_id,productId:row.product_id,objective:row.objective,format:row.format,headline:row.headline,body:row.body,cta:row.cta,variantCount:row.variant_count,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at};}
async function assertProject(client:Pool|PoolClient,workspaceId:string,projectId:string){if(!(await client.query("SELECT 1 FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,projectId])).rowCount)throw new HttpError(404,"Project not found");}
async function assertImages(client:PoolClient,workspaceId:string,projectId:string,ids:string[]){
  if(!ids.length)return;
  const rows=(await client.query("SELECT id,project_id FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND media_type IN ('image','layer','reference')",[workspaceId,ids])).rows;
  if(rows.length!==new Set(ids).size)throw new HttpError(422,"Choose supported image assets from this workspace");
  if(rows.some(row=>row.project_id!==null&&row.project_id!==projectId))throw new HttpError(422,"Images must belong to this exact project or be workspace-shared");
}
async function assertSharedLogo(client:PoolClient,workspaceId:string,id:string|null|undefined){
  if(!id)return;
  if(!(await client.query("SELECT 1 FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id IS NULL AND media_type IN ('image','layer','reference')",[workspaceId,id])).rowCount)throw new HttpError(422,"Brand logos must be workspace-shared images");
}

export async function marketingRoutes(app:FastifyInstance,pool:Pool,store:DiskStore){
  const renders=new MarketingRenderService(pool,store);
  let readiness:Promise<Awaited<ReturnType<typeof checkMarketingRenderer>>>|undefined;
  app.get(`${base}/brand-kits`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);return (await pool.query("SELECT * FROM marketing_brand_kits WHERE workspace_id=$1 ORDER BY updated_at DESC,id",[workspaceId])).rows.map(brand);});
  app.post(`${base}/brand-kits`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=brandInput.parse(request.body);
    return transaction(pool,async client=>{await assertSharedLogo(client,workspaceId,body.logoAssetId);return brand((await client.query(`INSERT INTO marketing_brand_kits(id,workspace_id,created_by,name,primary_color,background_color,text_color,logo_asset_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[newId(),workspaceId,user.id,body.name,body.primaryColor,body.backgroundColor,body.textColor,body.logoAssetId??null])).rows[0]);});
  });
  app.patch(`${base}/brand-kits/:id`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId,"creator");const body=brandPatch.parse(request.body);
    return transaction(pool,async client=>{await assertSharedLogo(client,workspaceId,body.logoAssetId);const row=(await client.query(`UPDATE marketing_brand_kits SET name=$4,primary_color=$5,background_color=$6,text_color=$7,logo_asset_id=$8,revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING *`,[workspaceId,id,body.revision,body.name,body.primaryColor,body.backgroundColor,body.textColor,body.logoAssetId??null])).rows[0];
      if(!row){if((await client.query("SELECT 1 FROM marketing_brand_kits WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rowCount)throw new HttpError(409,"Brand kit changed; reload before saving");throw new HttpError(404,"Brand kit not found");}return brand(row);});
  });
  app.get(`${base}/products`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const {projectId}=projectQuery.parse(request.query);return (await pool.query("SELECT * FROM marketing_products WHERE workspace_id=$1 AND project_id=$2 ORDER BY updated_at DESC,id",[workspaceId,projectId])).rows.map(product);});
  app.post(`${base}/products`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=productInput.parse(request.body);
    return transaction(pool,async client=>{await assertProject(client,workspaceId,body.projectId);await assertImages(client,workspaceId,body.projectId,[body.imageAssetId,...body.additionalAssetIds]);return product((await client.query(`INSERT INTO marketing_products(id,workspace_id,project_id,created_by,name,description,image_asset_id,additional_asset_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[]) RETURNING *`,[newId(),workspaceId,body.projectId,user.id,body.name,body.description,body.imageAssetId,body.additionalAssetIds])).rows[0]);});
  });
  app.patch(`${base}/products/:id`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId,"creator");const body=productPatch.parse(request.body);
    return transaction(pool,async client=>{const current=(await client.query("SELECT project_id,revision FROM marketing_products WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];if(!current)throw new HttpError(404,"Product reference not found");if(current.revision!==body.revision)throw new HttpError(409,"Product reference changed; reload before saving");await assertImages(client,workspaceId,current.project_id,[body.imageAssetId,...body.additionalAssetIds]);return product((await client.query(`UPDATE marketing_products SET name=$3,description=$4,image_asset_id=$5,additional_asset_ids=$6::uuid[],revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,[workspaceId,id,body.name,body.description,body.imageAssetId,body.additionalAssetIds])).rows[0]);});
  });
  app.get(`${base}/briefs`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const {projectId}=projectQuery.parse(request.query);return (await pool.query("SELECT * FROM marketing_briefs WHERE workspace_id=$1 AND project_id=$2 ORDER BY updated_at DESC,id",[workspaceId,projectId])).rows.map(brief);});
  app.post(`${base}/briefs`,async request=>{
    const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=briefInput.parse(request.body);
    return transaction(pool,async client=>{await assertProject(client,workspaceId,body.projectId);if(!(await client.query("SELECT 1 FROM marketing_brand_kits WHERE workspace_id=$1 AND id=$2",[workspaceId,body.brandKitId])).rowCount)throw new HttpError(404,"Brand kit not found");if(!(await client.query("SELECT 1 FROM marketing_products WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[workspaceId,body.productId,body.projectId])).rowCount)throw new HttpError(404,"Product reference not found for this project");return brief((await client.query(`INSERT INTO marketing_briefs(id,workspace_id,project_id,brand_kit_id,product_id,created_by,objective,format,headline,body,cta,variant_count)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[newId(),workspaceId,body.projectId,body.brandKitId,body.productId,user.id,body.objective,body.format,body.headline,body.body,body.cta,body.variantCount])).rows[0]);});
  });
  app.patch(`${base}/briefs/:id`,async request=>{
    const {workspaceId,id}=item.parse(request.params);await member(pool,request,workspaceId,"creator");const body=briefPatch.parse(request.body);
    return transaction(pool,async client=>{const current=(await client.query("SELECT project_id,revision FROM marketing_briefs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];if(!current)throw new HttpError(404,"Marketing brief not found");if(current.revision!==body.revision)throw new HttpError(409,"Marketing brief changed; reload before saving");if(!(await client.query("SELECT 1 FROM marketing_brand_kits WHERE workspace_id=$1 AND id=$2",[workspaceId,body.brandKitId])).rowCount)throw new HttpError(404,"Brand kit not found");if(!(await client.query("SELECT 1 FROM marketing_products WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[workspaceId,body.productId,current.project_id])).rowCount)throw new HttpError(404,"Product reference not found for this project");return brief((await client.query(`UPDATE marketing_briefs SET brand_kit_id=$3,product_id=$4,objective=$5,format=$6,headline=$7,body=$8,cta=$9,variant_count=$10,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`,[workspaceId,id,body.brandKitId,body.productId,body.objective,body.format,body.headline,body.body,body.cta,body.variantCount])).rows[0]);});
  });
  app.get(`${base}/assets`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const {projectId}=projectQuery.parse(request.query);await assertProject(pool,workspaceId,projectId);const rows=(await pool.query(`SELECT id,project_id,name,content_type,sha256,bytes,created_at FROM assets WHERE workspace_id=$1 AND (project_id=$2 OR project_id IS NULL) AND media_type IN ('image','layer','reference') ORDER BY created_at DESC,id`,[workspaceId,projectId])).rows;return {items:rows.map(row=>({id:row.id,projectId:row.project_id,name:row.name,contentType:row.content_type,sha256:row.sha256,bytes:Number(row.bytes),createdAt:row.created_at}))};});
  app.get(`${base}/readiness`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const result=await (readiness??=checkMarketingRenderer());return {status:result.ready?"ready":"missing",renderer:MARKETING_RENDERER,...(!result.ready?{error:result.error}:{}),limits:{formats:marketingFormats.map(format=>({format,...formatSpec[format]})),variantCount:{min:1,max:6}}};});
  app.post(`${base}/renders`,async request=>{const {workspaceId}=ws.parse(request.params),user=await member(pool,request,workspaceId,"creator"),body=renderInput.parse(request.body);return renders.admit(workspaceId,user.id,body);});
  app.get(`${base}/variants`,async request=>{const {workspaceId}=ws.parse(request.params);await member(pool,request,workspaceId);const {projectId}=projectQuery.parse(request.query);return (await pool.query("SELECT * FROM marketing_variants WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at DESC,variant_index",[workspaceId,projectId])).rows.map(publicVariant);});
  return renders;
}
