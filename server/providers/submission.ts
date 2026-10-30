import type {PoolClient} from "pg";
import type {CapabilityBundle,Invocation} from "../../src/capabilities/types";
import {HttpError} from "../auth";
import {newId} from "../crypto";
import {requestSchema,publicColumns} from "../run-submission";
import {elementInputsSchema,resolveRunInputs} from "../element-inputs";
import type {DirectRegistry} from "./registry";
import {ROUTER_MODELS,routerInputProblem} from '../../src/capabilities/router-models';

// Local/storyboard RunRequest and PreparedRun remain unchanged.
export const admissionSchema=requestSchema.extend({workerId:requestSchema.shape.workerId.optional(),elementInputs:elementInputsSchema.optional()});
type Admission=ReturnType<typeof admissionSchema.parse>;

export async function enqueueDirect(client:PoolClient,catalogue:CapabilityBundle[],registry:DirectRegistry,workspaceId:string,userId:string,body:Admission,requestHash:string){
  if(body.workerId!==undefined)throw new HttpError(400,"Direct execution does not use a ComfyUI worker");
  if(body.tracking!==undefined)throw new HttpError(400,"Tracking input is not supported by this route");
  if(!(await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,body.projectId])).rowCount)throw new HttpError(404,"Project not found");
  const manifest=catalogue.find(b=>b.manifest.id===body.capabilityId)?.manifest;
  if(!manifest)throw new HttpError(404,"Capability not found");
  if(manifest.version!==body.version)throw new HttpError(400,"Capability revision mismatch");
  const entry=registry.resolve(manifest,body.routeId);
  if(!entry)throw new HttpError(422,"No qualified direct provider adapter is available for this route");
  if(entry.binding.provider==='comfy-router'&&body.consent?.cloudCredits!==true)throw new HttpError(400,'Confirm Comfy credit usage before queueing this cloud render');
  if(!manifest.audioPolicies.includes(body.audioPolicy))throw new HttpError(400,"Unsupported audio policy");
  const resolved=await resolveRunInputs(client,manifest,workspaceId,body.projectId,body.inputs,body.elementInputs);
  if(entry.binding.provider==='comfy-router'){
    const model=ROUTER_MODELS.find(m=>m.id===manifest.id);
    if(!model)throw new HttpError(422,'Cloud model contract is unavailable');
    const rows=(await client.query('SELECT id,content_type,bytes,metadata FROM assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,Object.values(resolved.inputIds)])).rows;
    const checked=Object.fromEntries(Object.entries(resolved.inputIds).map(([role,id])=>[role,rows.find(a=>a.id===id)]));
    const problem=routerInputProblem(model,checked);if(problem)throw new HttpError(400,problem);
  }
  if(Object.keys(body.controls).some(id=>!manifest.controls.some(c=>c.id===id)))throw new HttpError(400,"Unknown control");
  const controls:Record<string,unknown>={};
  for(const c of manifest.controls){
    if(c.disabledReason){if(c.id in body.controls)throw new HttpError(400,"Control is unavailable");continue;}
    if(!c.apiField)throw new HttpError(422,"Provider control binding is unavailable");
    const v=body.controls[c.id]??c.default;
    if(c.type==="string"&&(typeof v!=="string"||v.length>20000)||c.type==="boolean"&&typeof v!=="boolean"||["number","integer"].includes(c.type)&&(typeof v!=="number"||!Number.isFinite(v)||c.type==="integer"&&!Number.isSafeInteger(v)||c.min!==undefined&&v<c.min||c.max!==undefined&&v>c.max)||c.type==="select"&&!c.options?.includes(v as string|number))throw new HttpError(400,"Invalid provider control value");
    controls[c.id]=v;
  }
  if(manifest.resolutions&&!Object.values(manifest.resolutions).some(r=>r.width===controls.width&&r.height===controls.height))throw new HttpError(400,"Unsupported resolution pair");
  const invocation:Invocation={capabilityId:manifest.id,version:manifest.version,routeId:body.routeId,inputs:resolved.inputIds,controls,audioPolicy:body.audioPolicy,...(Object.keys(resolved.elementInputSnapshots).length?{elementInputSnapshots:resolved.elementInputSnapshots}:{})};
  if(entry.binding.provider==='comfy-router')invocation.consent={cloudCredits:true};
  try{if(entry.adapter.validate(structuredClone(invocation))?.valid!==true)throw new Error();}catch{throw new HttpError(400,"Provider rejected the input parameters");}
  const connection=(await client.query("SELECT id,credential_revision FROM provider_connections WHERE workspace_id=$1 AND provider_id=$2",[workspaceId,entry.binding.provider])).rows[0];
  if(!connection)throw new HttpError(422,"Workspace provider credentials are required");
  const id=newId();
  const run=(await client.query(`INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING ${publicColumns}`,[id,workspaceId,body.projectId,userId,manifest.id,manifest.version,body.routeId,JSON.stringify(invocation),requestHash,body.idempotencyKey])).rows[0];
  await client.query("INSERT INTO provider_run_bindings(workspace_id,run_id,manifest,binding,binding_hash,connection_id,credential_revision,request_token) VALUES($1,$2,$3,$4,$5,$6,$7,$2)",[workspaceId,id,JSON.stringify(manifest),JSON.stringify(entry.binding),entry.hash,connection.id,connection.credential_revision]);
  for(const [role,assetId] of Object.entries(resolved.inputIds))await client.query("INSERT INTO run_inputs(workspace_id,run_id,asset_id,role) VALUES($1,$2,$3,$4)",[workspaceId,id,assetId,role]);
  await client.query("INSERT INTO run_events(workspace_id,run_id,state) VALUES($1,$2,'pending')",[workspaceId,id]);
  return run;
}
