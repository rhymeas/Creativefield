import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {Pool,type PoolClient} from "pg";
import {migrate} from "../server/db";
import {durableArtifactStorageKeys,persistArtifactPlan,planArtifactSlots,publishStagedArtifactBatch,recordStagedArtifactBatch,type ArtifactPublicationInput} from "../server/image-artifacts";

const connectionString=process.env.TEST_DATABASE_URL;

describe.skipIf(!connectionString)("image artifact atomic publication against real PostgreSQL",()=>{
  const schema=`cf_image_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool,userId:string,workspaceId:string,projectId:string,otherProjectId:string,sourceId:string;
  beforeAll(async()=>{
    admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    userId=randomUUID();workspaceId=randomUUID();projectId=randomUUID();otherProjectId=randomUUID();sourceId=randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'fixture')",[userId,`${userId}@example.test`]);
    await pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Fixture')",[workspaceId]);
    await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Canvas',$3),($4,$2,'Other',$3)",[projectId,workspaceId,userId,otherProjectId]);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'source.png','image','image/png',$4,$5,10,$6)",[sourceId,workspaceId,projectId,`${workspaceId}/${sourceId}`,"1".repeat(64),userId]);
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});

  async function staged(runId:string,relationId=sourceId,relationMetadata?:Record<string,unknown>):Promise<ArtifactPublicationInput>{
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key) VALUES($1,$2,$3,$4,'fixture-image','1','local','running','{}','fixture',$5)",[runId,workspaceId,projectId,userId,runId]);
    const specs=[{role:"composite",ordinal:0,mediaType:"image" as const}];
    await persistArtifactPlan(pool,{workspaceId,projectId,runId,specs});
    const [plan]=planArtifactSlots(runId,specs);
    const input:ArtifactPublicationInput={workspaceId,projectId,runId,createdBy:userId,artifacts:[{...plan,name:"composite.png",contentType:"image/png",storageKey:`${workspaceId}/${plan.assetId}`,sha256:"a".repeat(64),bytes:100,metadata:{imageValidation:{validationVersion:1,format:"png",width:1,height:1,hasAlpha:true,semantic:"image"}},relations:[{assetId:relationId,role:"source",ordinal:0,...(relationMetadata?{metadata:relationMetadata}:{})}]}]};
    await recordStagedArtifactBatch(pool,input);return input;
  }

  it("rolls back the whole batch when a relation is outside the project",async()=>{
    const foreignSource=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'other.png','image','image/png',$4,$5,10,$6)",[foreignSource,workspaceId,otherProjectId,`${workspaceId}/${foreignSource}`,"2".repeat(64),userId]);
    const input=await staged(randomUUID(),foreignSource);
    await expect(publishStagedArtifactBatch(pool,input)).rejects.toMatchObject({statusCode:422});
    expect((await pool.query("SELECT id FROM assets WHERE id=$1",[input.artifacts[0].assetId])).rowCount).toBe(0);
    expect((await pool.query("SELECT state FROM runs WHERE id=$1",[input.runId])).rows[0].state).toBe("running");
  });

  it("re-reads durable publication after a lost COMMIT acknowledgement",async()=>{
    const input=await staged(randomUUID());let loseAck=true;
    const uncertain={
      query:pool.query.bind(pool),
      connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        const wrapped=new Proxy(client,{get(target,key,receiver){
          if(key==="query")return async(...args:any[])=>{
            if(typeof args[0]==="string"&&args[0]==="COMMIT"&&loseAck){await query("COMMIT");loseAck=false;throw new Error("connection lost after commit");}
            return (query as any)(...args);
          };
          return Reflect.get(target,key,receiver);
        }});
        return wrapped as PoolClient;
      },
    } as unknown as Pool;
    await expect(publishStagedArtifactBatch(uncertain,input)).resolves.toEqual({status:"already_published",outputIds:[input.artifacts[0].assetId]});
    const relation=(await pool.query("SELECT role,ordinal,related_asset_id FROM asset_relations WHERE asset_id=$1",[input.artifacts[0].assetId])).rows[0];
    expect(relation).toMatchObject({role:"source",ordinal:0,related_asset_id:sourceId});
  });

  it("retains published storage after a lost COMMIT acknowledgement and failed first recovery read",async()=>{
    const input=await staged(randomUUID());let loseAck=true,failRecovery=true;const poolQuery=pool.query.bind(pool);
    const uncertain={
      query:async(...args:any[])=>{if(failRecovery){failRecovery=false;throw new Error("database unavailable during durable reread");}return (poolQuery as any)(...args);},
      connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        return new Proxy(client,{get(target,key,receiver){
          if(key==="query")return async(...args:any[])=>{
            if(typeof args[0]==="string"&&args[0]==="COMMIT"&&loseAck){await query("COMMIT");loseAck=false;throw new Error("connection lost after commit");}
            return (query as any)(...args);
          };
          return Reflect.get(target,key,receiver);
        }}) as PoolClient;
      },
    } as unknown as Pool;
    await expect(publishStagedArtifactBatch(uncertain,input)).rejects.toThrow(/connection lost after commit/);
    await expect(durableArtifactStorageKeys(uncertain,{workspaceId,runId:input.runId,assetIds:[input.artifacts[0].assetId]})).resolves.toEqual(new Set([input.artifacts[0].storageKey]));
    expect((await pool.query("SELECT state FROM runs WHERE id=$1",[input.runId])).rows[0].state).toBe("succeeded");
  });

  it("rechecks cancellation under the run row lock before publication",async()=>{
    const input=await staged(randomUUID());await pool.query("UPDATE runs SET state='cancel_requested' WHERE id=$1",[input.runId]);
    await expect(publishStagedArtifactBatch(pool,input)).resolves.toEqual({status:"canceled",outputIds:[]});
    expect((await pool.query("SELECT id FROM assets WHERE id=$1",[input.artifacts[0].assetId])).rowCount).toBe(0);
    expect((await pool.query("SELECT state FROM run_artifact_slots WHERE run_id=$1",[input.runId])).rows[0].state).toBe("discarded");
  });

  it("rejects altered staged semantics and wrong-creator replay",async()=>{
    const altered=await staged(randomUUID());
    const forged={...altered,artifacts:altered.artifacts.map(artifact=>({...artifact,name:"forged.png",mediaType:"mask" as const,metadata:{imageValidation:{validationVersion:1,format:"png",width:999,height:1,hasAlpha:true,semantic:"mask"}}}))};
    await expect(publishStagedArtifactBatch(pool,forged)).rejects.toMatchObject({statusCode:409});
    expect((await pool.query("SELECT id FROM assets WHERE id=$1",[altered.artifacts[0].assetId])).rowCount).toBe(0);

    const published=await staged(randomUUID(),sourceId,{assetSha256:"b".repeat(64),storagePath:"private/path",nested:{token:"nope"}});
    await expect(publishStagedArtifactBatch(pool,published)).resolves.toMatchObject({status:"published"});
    const relation=(await pool.query("SELECT metadata FROM asset_relations WHERE asset_id=$1",[published.artifacts[0].assetId])).rows[0];
    expect(relation.metadata).toEqual({assetSha256:"b".repeat(64)});
    await expect(publishStagedArtifactBatch(pool,{...published,createdBy:randomUUID()})).rejects.toMatchObject({statusCode:403});
  });
});
