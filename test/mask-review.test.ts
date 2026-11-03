import {afterEach,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Readable} from "node:stream";
import type {PoolClient} from "pg";
import {DiskStore} from "../server/storage";
import {reviewSourceLinkedMask} from "../server/masked-routes";

const sha=(character:string)=>character.repeat(64);

describe("source-linked mask review decision",()=>{
  const roots:string[]=[];
  afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

  async function fixture(){
    const root=await mkdtemp(path.join(tmpdir(),"cf-mask-review-"));roots.push(root);
    const store=new DiskStore(root,1024),workspaceId=randomUUID(),projectId=randomUUID(),sourceId=randomUUID(),maskId=randomUUID(),runId=randomUUID(),revisionId=randomUUID(),reviewedBy=randomUUID();
    const sourceSaved=await store.put(workspaceId,Readable.from(Buffer.from("source-video")));
    const maskSaved=await store.put(workspaceId,Readable.from(Buffer.from("mask-video")));
    const source={id:sourceId,project_id:projectId,media_type:"video",content_type:"video/mp4",storage_key:sourceSaved.key,sha256:sourceSaved.sha256};
    const linked={
      validationVersion:1,contract:"source_linked_mask_v1",sourceAssetId:sourceId,sourceSha256:sourceSaved.sha256,maskAssetId:maskId,maskSha256:maskSaved.sha256,
      projectId,producerRunId:runId,width:160,height:96,fps:16,frames:17,timingDigest:sha("c"),semantics:"white_edits_black_preserves",
      workflowId:"sam21-video-mask",workflowVersion:"0.1.0",routeId:"local",workflowRevisionId:revisionId,workflowSha256:sha("d"),requiredCheckpoint:"sam.safetensors",requiredCheckpointSha256:sha("e"),
    };
    const asset:{id:string;workspace_id:string;project_id:string;parent_id:string;media_type:string;content_type:string;storage_key:string;sha256:string;metadata:Record<string,any>}={id:maskId,workspace_id:workspaceId,project_id:projectId,parent_id:sourceId,media_type:"mask",content_type:"video/mp4",storage_key:maskSaved.key,sha256:maskSaved.sha256,metadata:{sourceLinkedMask:linked,maskReview:{version:1,state:"pending"}}};
    const run={id:runId,project_id:projectId,route_id:linked.routeId,state:"succeeded",workflow_revision_id:revisionId,output_ids:[maskId]};
    const revision={id:revisionId,capability_id:linked.workflowId,version:linked.workflowVersion,sha256:linked.workflowSha256,manifest:{id:linked.workflowId,version:linked.workflowVersion,outputContract:{kind:"source_linked_mask_v1",checkpointRequirementId:"model:sam",semantics:"white_edits_black_preserves"},routes:[{id:linked.routeId,requirements:[{id:"model:sam",kind:"model",name:linked.requiredCheckpoint,version:`sha256:${linked.requiredCheckpointSha256}`}]}]}};
    const events:any[][]=[],updates:any[][]=[];
    const client={query:async(text:string,values:any[])=>{
      if(text.startsWith("SELECT id,workspace_id"))return {rows:[asset],rowCount:1};
      if(text.startsWith("SELECT id,project_id,media_type"))return {rows:[source],rowCount:1};
      if(text.startsWith("SELECT id,project_id,route_id,state"))return {rows:[run],rowCount:1};
      if(text.startsWith("SELECT id,capability_id"))return {rows:[revision],rowCount:1};
      if(text.startsWith("UPDATE assets")){updates.push(values);asset.metadata=JSON.parse(values[2]);return {rows:[],rowCount:1};}
      if(text.startsWith("INSERT INTO run_events")){events.push(values);return {rows:[],rowCount:1};}
      throw new Error(`Unexpected query: ${text}`);
    }} as unknown as PoolClient;
    return {store,client,workspaceId,projectId,sourceId,maskId,runId,reviewedBy,asset,source,linked,events,updates,root};
  }

  it("approves once, derives the VACE receipt and returns the stored decision idempotently",async()=>{
    const f=await fixture(),input={workspaceId:f.workspaceId,maskAssetId:f.maskId,decision:"approve" as const,expectedSha256:f.asset.sha256,reviewedBy:f.reviewedBy};
    const first=await reviewSourceLinkedMask(f.client,f.store,input);
    expect(first).toMatchObject({decision:"approved",maskAssetId:f.maskId,sourceAssetId:f.sourceId,producerRunId:f.runId,reviewedBy:f.reviewedBy});
    expect(f.asset.metadata.maskSequence).toEqual({
      validationVersion:1,sourceAssetId:f.sourceId,sourceSha256:f.source.sha256,maskSha256:f.asset.sha256,width:160,height:96,fps:16,frames:17,
      timingDigest:sha("c"),semantics:"white_edits_black_preserves",
    });
    expect(f.events).toHaveLength(1);expect(f.events[0][2]).toBe("mask_review_approved");
    await rm(await f.store.file(f.workspaceId,f.asset.storage_key));
    const repeated=await reviewSourceLinkedMask(f.client,f.store,input);
    expect(repeated).toEqual(first);expect(f.updates).toHaveLength(1);expect(f.events).toHaveLength(1);
    await expect(reviewSourceLinkedMask(f.client,f.store,{...input,decision:"reject"})).rejects.toMatchObject({statusCode:409});
  });

  it("rejects terminally without publishing a maskSequence",async()=>{
    const f=await fixture();
    const receipt=await reviewSourceLinkedMask(f.client,f.store,{workspaceId:f.workspaceId,maskAssetId:f.maskId,decision:"reject",expectedSha256:f.asset.sha256,reviewedBy:f.reviewedBy});
    expect(receipt.decision).toBe("rejected");
    expect(f.asset.metadata.maskReview).toMatchObject({version:1,state:"rejected",receipt});
    expect(f.asset.metadata).not.toHaveProperty("maskSequence");
    expect(f.events[0][2]).toBe("mask_review_rejected");
  });

  it("refuses stale expected hashes and disk mutation before any durable change",async()=>{
    const stale=await fixture();
    await expect(reviewSourceLinkedMask(stale.client,stale.store,{workspaceId:stale.workspaceId,maskAssetId:stale.maskId,decision:"approve",expectedSha256:sha("0"),reviewedBy:stale.reviewedBy})).rejects.toMatchObject({statusCode:409});
    expect(stale.updates).toHaveLength(0);
    const changed=await fixture(),filename=await changed.store.file(changed.workspaceId,changed.asset.storage_key);await writeFile(filename,"tampered");
    await expect(reviewSourceLinkedMask(changed.client,changed.store,{workspaceId:changed.workspaceId,maskAssetId:changed.maskId,decision:"approve",expectedSha256:changed.asset.sha256,reviewedBy:changed.reviewedBy})).rejects.toMatchObject({statusCode:422});
    expect(changed.updates).toHaveLength(0);expect(changed.events).toHaveLength(0);
  });

  it("refuses producer, revision and source lineage mismatches",async()=>{
    const wrongRun=await fixture();wrongRun.linked.producerRunId=randomUUID();
    await expect(reviewSourceLinkedMask(wrongRun.client,wrongRun.store,{workspaceId:wrongRun.workspaceId,maskAssetId:wrongRun.maskId,decision:"approve",expectedSha256:wrongRun.asset.sha256,reviewedBy:wrongRun.reviewedBy})).rejects.toMatchObject({statusCode:422});
    const wrongSource=await fixture();wrongSource.source.sha256=sha("f");
    await expect(reviewSourceLinkedMask(wrongSource.client,wrongSource.store,{workspaceId:wrongSource.workspaceId,maskAssetId:wrongSource.maskId,decision:"approve",expectedSha256:wrongSource.asset.sha256,reviewedBy:wrongSource.reviewedBy})).rejects.toMatchObject({statusCode:422});
    const wrongRoute=await fixture();
    (wrongRoute as any).linked.routeId="other";
    await expect(reviewSourceLinkedMask(wrongRoute.client,wrongRoute.store,{workspaceId:wrongRoute.workspaceId,maskAssetId:wrongRoute.maskId,decision:"approve",expectedSha256:wrongRoute.asset.sha256,reviewedBy:wrongRoute.reviewedBy})).rejects.toMatchObject({statusCode:422});
  });
});
