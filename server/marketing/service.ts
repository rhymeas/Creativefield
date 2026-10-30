import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { Pool } from "pg";
import { Readable } from "node:stream";
import { HttpError } from "../auth";
import { newId } from "../crypto";
import { transaction } from "../db";
import type { DiskStore } from "../storage";
import { MARKETING_RENDERER, renderStaticAd, validateMarketingRaster } from "./renderer";

const RECIPE_ID="comfyfield-marketing-static-ad",RECIPE_VERSION="1.0.0";
const manifestUrl=new URL("../../native-workflows/marketing/static-ad-v1/manifest.json",import.meta.url);
type AssetRow={id:string;project_id:string|null;name:string;content_type:string;storage_key:string;sha256:string;bytes:string|number};
type Snapshot={
  schemaVersion:1;projectId:string;briefId:string;briefRevision:number;variantIndex:number;format:"square_1080"|"portrait_1080x1350"|"landscape_1920x1080"|"story_1080x1920";
  objective:string;headline:string;body:string;cta:string;
  brand:{id:string;revision:number;name:string;primaryColor:string;backgroundColor:string;textColor:string;fontIdentity:string;logoAssetId:string|null};
  product:{id:string;revision:number;name:string;description:string;imageAssetId:string;additionalAssetIds:string[]};
  sources:Array<{id:string;scope:"project"|"workspace";projectId:string|null;contentType:string;bytes:number;sha256:string}>;
  recipe:{id:string;version:string;sha256:string;rendererId:string;rendererVersion:string;font:string};
};

function digest(value:Buffer|string){return createHash("sha256").update(value).digest("hex");}
async function recipeHash(){return digest(await readFile(manifestUrl));}
function publicVariant(row:Record<string,unknown>){
  const snapshot=row.snapshot as Snapshot;
  return {id:row.id,projectId:row.project_id,briefId:row.brief_id,variantIndex:row.variant_index,state:row.state,outputAssetId:row.output_asset_id??null,error:row.error??null,format:snapshot.format,brandName:snapshot.brand.name,productName:snapshot.product.name,createdAt:row.created_at,updatedAt:row.updated_at,snapshot};
}

export class MarketingRenderService{
  private active=0;
  private readonly waiting:Array<()=>void>=[];
  private readonly closeWaiters:Array<()=>void>=[];
  private closed=false;
  constructor(readonly pool:Pool,readonly store:DiskStore,readonly concurrency=2){}
  private async slot<T>(work:()=>Promise<T>):Promise<T>{
    if(this.closed)throw new Error("Marketing renderer is shutting down");
    if(this.active>=this.concurrency)await new Promise<void>(resolve=>this.waiting.push(resolve));
    this.active++;
    try{return await work();}finally{
      this.active--;this.waiting.shift()?.();
      if(this.active===0&&this.waiting.length===0)while(this.closeWaiters.length)this.closeWaiters.shift()?.();
    }
  }
  private async source(row:AssetRow,workspaceId:string,projectId:string){
    if(row.project_id!==null&&row.project_id!==projectId)throw new Error("Frozen source is no longer authorized for this project");
    const expected=Number(row.bytes);
    if(!Number.isSafeInteger(expected)||expected<1||expected>25*1024*1024)throw new Error("Frozen source exceeds the local renderer byte limit");
    const filename=await this.store.file(workspaceId,row.storage_key),actual=(await stat(filename)).size;
    if(actual!==expected)throw new Error("Frozen source byte count changed before rendering");
    const bytes=await readFile(filename);
    if(digest(bytes)!==row.sha256)throw new Error("Frozen source checksum changed before rendering");
    return bytes;
  }
  async admit(workspaceId:string,userId:string,input:{projectId:string;briefId:string;idempotencyKey:string}){
    if(this.closed)throw new HttpError(503,"Marketing renderer is shutting down");
    const prepared=await transaction(this.pool,async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${workspaceId}/marketing/${input.idempotencyKey}`]);
      const brief=(await client.query(`SELECT b.*,k.name AS brand_name,k.primary_color,k.background_color,k.text_color,k.font_identity,k.logo_asset_id,k.revision AS brand_revision,
        p.name AS product_name,p.description AS product_description,p.image_asset_id,p.additional_asset_ids,p.revision AS product_revision
        FROM marketing_briefs b JOIN marketing_brand_kits k ON k.workspace_id=b.workspace_id AND k.id=b.brand_kit_id
        JOIN marketing_products p ON p.workspace_id=b.workspace_id AND p.id=b.product_id
        WHERE b.workspace_id=$1 AND b.id=$2 AND b.project_id=$3 AND p.project_id=b.project_id`,[workspaceId,input.briefId,input.projectId])).rows[0];
      if(!brief)throw new HttpError(404,"Marketing brief not found for this project");
      const payloadHash=digest(JSON.stringify({projectId:input.projectId,briefId:input.briefId,briefRevision:brief.revision,variantCount:brief.variant_count}));
      const existing=(await client.query("SELECT * FROM marketing_variants WHERE workspace_id=$1 AND idempotency_key=$2 ORDER BY variant_index",[workspaceId,input.idempotencyKey])).rows;
      if(existing.length){
        if(existing.some(row=>row.payload_hash!==payloadHash))throw new HttpError(409,"Idempotency key was already used for a different marketing brief revision");
        return {repeated:true,rows:existing};
      }
      const assetIds=[brief.image_asset_id,...brief.additional_asset_ids,...(brief.logo_asset_id?[brief.logo_asset_id]:[])];
      const assets=(await client.query("SELECT id,project_id,name,content_type,storage_key,sha256,bytes FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND media_type IN ('image','layer','reference')",[workspaceId,assetIds])).rows as AssetRow[];
      if(assets.length!==new Set(assetIds).size)throw new HttpError(422,"A marketing source image is missing or unsupported");
      const byId=new Map(assets.map(asset=>[asset.id,asset]));
      for(const asset of assets)if(asset.project_id!==null&&asset.project_id!==input.projectId)throw new HttpError(422,"Marketing sources must belong to this exact project or be workspace-shared");
      if(brief.logo_asset_id&&byId.get(brief.logo_asset_id)?.project_id!==null)throw new HttpError(422,"Brand logos must be workspace-shared assets");
      await Promise.all(assets.map(async asset=>validateMarketingRaster(await this.source(asset,workspaceId,input.projectId),asset.id===brief.logo_asset_id?"Logo":"Product source")));
      const recipeSha256=await recipeHash();
      const sourceSnapshots=assets.map(asset=>({id:asset.id,scope:(asset.project_id===null?"workspace":"project") as "workspace"|"project",projectId:asset.project_id,contentType:asset.content_type,bytes:Number(asset.bytes),sha256:asset.sha256}));
      const rows=[];
      for(let variantIndex=0;variantIndex<brief.variant_count;variantIndex++){
        const id=newId();
        const snapshot:Snapshot={schemaVersion:1,projectId:input.projectId,briefId:brief.id,briefRevision:brief.revision,variantIndex,format:brief.format,objective:brief.objective,headline:brief.headline,body:brief.body,cta:brief.cta,
          brand:{id:brief.brand_kit_id,revision:brief.brand_revision,name:brief.brand_name,primaryColor:brief.primary_color,backgroundColor:brief.background_color,textColor:brief.text_color,fontIdentity:brief.font_identity,logoAssetId:brief.logo_asset_id},
          product:{id:brief.product_id,revision:brief.product_revision,name:brief.product_name,description:brief.product_description,imageAssetId:brief.image_asset_id,additionalAssetIds:brief.additional_asset_ids},
          sources:sourceSnapshots,recipe:{id:RECIPE_ID,version:RECIPE_VERSION,sha256:recipeSha256,rendererId:MARKETING_RENDERER.id,rendererVersion:MARKETING_RENDERER.version,font:MARKETING_RENDERER.font}};
        rows.push((await client.query(`INSERT INTO marketing_variants(id,workspace_id,project_id,brief_id,created_by,variant_index,snapshot,recipe_id,recipe_version,recipe_sha256,state,idempotency_key,payload_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12) RETURNING *`,[id,workspaceId,input.projectId,brief.id,userId,variantIndex,JSON.stringify(snapshot),RECIPE_ID,RECIPE_VERSION,recipeSha256,input.idempotencyKey,payloadHash])).rows[0]);
      }
      return {repeated:false,rows};
    });
    if(!prepared.repeated)await Promise.all(prepared.rows.map(row=>this.slot(()=>this.process(workspaceId,row.id))));
    const rows=(await this.pool.query("SELECT * FROM marketing_variants WHERE workspace_id=$1 AND idempotency_key=$2 ORDER BY variant_index",[workspaceId,input.idempotencyKey])).rows;
    return {repeated:prepared.repeated,variants:rows.map(publicVariant)};
  }
  async process(workspaceId:string,id:string){
    const claimed=(await this.pool.query("UPDATE marketing_variants SET state='rendering',error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='queued' RETURNING *",[workspaceId,id])).rows[0];
    if(!claimed)return;
    let saved:Awaited<ReturnType<DiskStore["put"]>>|undefined;
    try{
      const snapshot=claimed.snapshot as Snapshot;
      if(snapshot.recipe.sha256!==await recipeHash()||snapshot.recipe.id!==RECIPE_ID||snapshot.recipe.version!==RECIPE_VERSION)throw new Error("Frozen marketing recipe is unavailable or changed");
      const ids=snapshot.sources.map(source=>source.id);
      const assets=(await this.pool.query("SELECT id,project_id,name,content_type,storage_key,sha256,bytes FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",[workspaceId,ids])).rows as AssetRow[];
      if(assets.length!==ids.length)throw new Error("Frozen marketing source is missing");
      const byId=new Map(assets.map(asset=>[asset.id,asset]));
      for(const frozen of snapshot.sources){
        const current=byId.get(frozen.id);
        if(!current||current.project_id!==frozen.projectId||current.content_type!==frozen.contentType||Number(current.bytes)!==frozen.bytes||current.sha256!==frozen.sha256)throw new Error("Frozen marketing source metadata changed before rendering");
      }
      const product=await this.source(byId.get(snapshot.product.imageAssetId)!,workspaceId,snapshot.projectId);
      const logo=snapshot.brand.logoAssetId?await this.source(byId.get(snapshot.brand.logoAssetId)!,workspaceId,snapshot.projectId):undefined;
      const rendered=await renderStaticAd({format:snapshot.format,variantIndex:snapshot.variantIndex,headline:snapshot.headline,body:snapshot.body,cta:snapshot.cta,primaryColor:snapshot.brand.primaryColor,backgroundColor:snapshot.brand.backgroundColor,textColor:snapshot.brand.textColor,productImage:product,logoImage:logo});
      saved=await this.store.put(workspaceId,Readable.from(rendered.png));
      if(saved.sha256!==digest(rendered.png))throw new Error("Published marketing output checksum mismatch");
      const assetId=newId();
      await transaction(this.pool,async client=>{
        const row=(await client.query("SELECT state FROM marketing_variants WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,id])).rows[0];
        if(row?.state!=="rendering")throw new Error("Marketing variant changed while rendering");
        await client.query(`INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata)
          VALUES($1,$2,$3,$4,'image','image/png',$5,$6,$7,$8,$9)`,[assetId,workspaceId,snapshot.projectId,`static-ad-${id}.png`,saved!.key,saved!.sha256,saved!.bytes,claimed.created_by,JSON.stringify({marketingVariantId:id,width:rendered.width,height:rendered.height,recipeId:RECIPE_ID,recipeVersion:RECIPE_VERSION,selectedTextColor:rendered.selectedTextColor,usedContrastFallback:rendered.usedContrastFallback})]);
        await client.query("UPDATE marketing_variants SET state='succeeded',output_asset_id=$3,error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[workspaceId,id,assetId]);
      });
    }catch(error){
      if(saved)await this.store.remove(workspaceId,saved.key).catch(()=>{});
      const message=(error as Error).message.replace(/[\r\n\t]+/g," ").slice(0,300)||"Local marketing render failed";
      await this.pool.query("UPDATE marketing_variants SET state='failed',error=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='rendering'",[workspaceId,id,message]);
    }
  }
  async recover(){
    if(this.closed)throw new Error("Marketing renderer is shutting down");
    await this.pool.query("UPDATE marketing_variants SET state='queued',error=NULL,updated_at=now() WHERE state='rendering'");
    let recovered=0;
    while(true){
      const pending=(await this.pool.query("SELECT workspace_id,id FROM marketing_variants WHERE state='queued' ORDER BY created_at LIMIT 100")).rows;
      if(!pending.length)break;
      await Promise.all(pending.map(row=>this.slot(()=>this.process(row.workspace_id,row.id))));
      recovered+=pending.length;
    }
    return {recovered};
  }
  async close(){
    this.closed=true;
    if(this.active===0&&this.waiting.length===0)return;
    await new Promise<void>(resolve=>this.closeWaiters.push(resolve));
  }
}

export {publicVariant};
