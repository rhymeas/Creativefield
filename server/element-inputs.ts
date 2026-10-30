import type {PoolClient} from "pg";
import {z} from "zod";
import {assetMatchesPort} from "../src/capabilities/assets";
import type {CapabilityManifestV2,ElementAssetSnapshotV1,MediaType} from "../src/capabilities/types";
import {HttpError} from "./auth";

export const MAX_ELEMENT_INPUTS=16;
export const elementInputBindingSchema=z.object({elementId:z.uuid(),assetId:z.uuid()}).strict();
export const elementInputsSchema=z.record(z.string().min(1).max(120),elementInputBindingSchema)
  .refine(value=>Object.keys(value).length<=MAX_ELEMENT_INPUTS,`Use at most ${MAX_ELEMENT_INPUTS} Element inputs`);
export type ElementInputBindings=z.infer<typeof elementInputsSchema>;

export type ResolvedRunAsset={
  id:string;project_id:string|null;media_type:MediaType;content_type:string;sha256:string;
  parent_id:string|null;metadata:Record<string,unknown>;storage_key:string;
};
export type ResolvedRunInputs={
  inputIds:Record<string,string>;
  assets:Record<string,ResolvedRunAsset>;
  elementInputSnapshots:Record<string,ElementAssetSnapshotV1>;
};

/** Pure admission checks run before any asset lookup. */
export function validateRunInputSelections(manifest:CapabilityManifestV2,directInputs:Record<string,string>,elementInputs:ElementInputBindings={}):void{
  const direct=Object.keys(directInputs),elements=Object.keys(elementInputs),known=new Set(manifest.inputs.map(port=>port.id));
  if(elements.length>MAX_ELEMENT_INPUTS)throw new HttpError(400,`Use at most ${MAX_ELEMENT_INPUTS} Element inputs`);
  if(direct.some(port=>!known.has(port))||elements.some(port=>!known.has(port)))throw new HttpError(400,"Unknown input");
  if(elements.some(port=>Object.hasOwn(directInputs,port)))throw new HttpError(400,"Input cannot use both a direct asset and an Element asset");
  for(const port of manifest.inputs)if(port.required&&!Object.hasOwn(directInputs,port.id)&&!Object.hasOwn(elementInputs,port.id))throw new HttpError(400,"Required input is missing");
}

/** Resolve both input forms to ordinary assets while freezing only stable Element provenance. */
export async function resolveRunInputs(client:PoolClient,manifest:CapabilityManifestV2,workspaceId:string,projectId:string,directInputs:Record<string,string>,elementInputs:ElementInputBindings={}):Promise<ResolvedRunInputs>{
  validateRunInputSelections(manifest,directInputs,elementInputs);
  const inputIds:Record<string,string>={},assets:Record<string,ResolvedRunAsset>={},elementInputSnapshots:Record<string,ElementAssetSnapshotV1>={};
  for(const [inputPort,assetId] of Object.entries(directInputs)){
    const asset=(await client.query("SELECT id,project_id,parent_id,media_type,content_type,sha256,metadata,storage_key FROM assets WHERE workspace_id=$1 AND id=$2 AND project_id=$3",[workspaceId,assetId,projectId])).rows[0] as ResolvedRunAsset|undefined;
    if(!asset)throw new HttpError(404,"Input asset not found");
    const port=manifest.inputs.find(candidate=>candidate.id===inputPort)!;
    if(!assetMatchesPort(asset,port))throw new HttpError(400,"Input media does not match the workflow port");
    inputIds[inputPort]=asset.id;assets[inputPort]={...asset,metadata:asset.metadata??{}};
  }
  for(const [inputPort,binding] of Object.entries(elementInputs)){
    const row=(await client.query(`SELECT COALESCE(d.id,a.id) AS id,COALESCE(d.project_id,a.project_id) AS project_id,COALESCE(d.parent_id,a.parent_id) AS parent_id,COALESCE(d.media_type,a.media_type) AS media_type,COALESCE(d.content_type,a.content_type) AS content_type,COALESCE(d.sha256,a.sha256) AS sha256,COALESCE(d.metadata,a.metadata) AS metadata,COALESCE(d.storage_key,a.storage_key) AS storage_key,e.kind AS element_kind,a.id AS source_asset_id,a.sha256 AS source_asset_sha256,a.media_type AS source_media_type,a.project_id AS source_project_id
      FROM elements e JOIN element_assets ea ON ea.workspace_id=e.workspace_id AND ea.element_id=e.id
      JOIN assets a ON a.workspace_id=ea.workspace_id AND a.id=ea.asset_id
      LEFT JOIN assets d ON d.workspace_id=a.workspace_id AND d.id=$3 AND d.parent_id=a.id
      WHERE e.workspace_id=$1 AND e.id=$2 AND (a.id=$3 OR d.id=$3) AND (COALESCE(d.project_id,a.project_id)=$4 OR COALESCE(d.project_id,a.project_id) IS NULL)`,[workspaceId,binding.elementId,binding.assetId,projectId])).rows[0] as (Omit<ResolvedRunAsset,"project_id">&{project_id:string|null;element_kind:ElementAssetSnapshotV1["elementKind"];source_asset_id?:string|null;source_asset_sha256?:string|null;source_media_type?:MediaType|null;source_project_id?:string|null})|undefined;
    if(!row)throw new HttpError(404,"Element asset not found");
    const port=manifest.inputs.find(candidate=>candidate.id===inputPort)!;
    if(!assetMatchesPort(row,port))throw new HttpError(400,"Input media does not match the workflow port");
    inputIds[inputPort]=row.id;
    assets[inputPort]={...row,metadata:row.metadata??{}};
    elementInputSnapshots[inputPort]={validationVersion:1,inputPort,elementId:binding.elementId,elementKind:row.element_kind,assetId:row.source_asset_id??row.id,assetSha256:row.source_asset_sha256??row.sha256,assetMediaType:row.source_media_type??row.media_type,assetProjectId:row.source_project_id!==undefined?row.source_project_id:row.project_id};
  }
  return {inputIds,assets,elementInputSnapshots};
}
