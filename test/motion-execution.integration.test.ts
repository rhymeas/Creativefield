import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomUUID} from "node:crypto";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {PgMotionLedgerStore,postMotionPrompt} from "../server/motion-execution";
import {MOTION_NORMALIZATION,type MotionMediaReceipt} from "../server/motion-media";

const connectionString=process.env.TEST_DATABASE_URL;
const hex=(c:string)=>c.repeat(64);
describe.skipIf(!connectionString)("motion preparation PostgreSQL ledger",()=>{
  const schema=`cf_motion_${randomUUID().replaceAll("-","")}`;
  let root:Pool,pool:Pool,workspaceId:string,userId:string,projectId:string,workerId:string,revisionId:string,assetId:string,storageKey:string;
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    workspaceId=(await bootstrap(pool,"motion-ledger@example.test","Fixture-password-long-27!","Motion ledger")).workspaceId;
    userId=(await pool.query("SELECT user_id FROM memberships WHERE workspace_id=$1",[workspaceId])).rows[0].user_id;
    projectId=randomUUID();workerId=randomUUID();revisionId=randomUUID();assetId=randomUUID();storageKey=`${workspaceId}/${assetId}`;
    await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$2,'Motion',$3)",[projectId,workspaceId,userId]);
    await pool.query("INSERT INTO workers(id,workspace_id,name,origin) VALUES($1,$2,'Fixture','http://127.0.0.1:1')",[workerId,workspaceId]);
    await pool.query("INSERT INTO workflow_revisions(id,workspace_id,capability_id,version,sha256,manifest,graph) VALUES($1,$2,'motion','1',$3,'{}','{}')",[revisionId,workspaceId,hex("d")]);
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'Drive','video','video/mp4',$4,$5,100,$6)",[assetId,workspaceId,projectId,storageKey,hex("a"),userId]);
  });
  afterAll(async()=>{await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});

  async function run(state="pending"){
    const id=randomUUID();
    await pool.query("INSERT INTO runs(id,workspace_id,project_id,worker_id,workflow_revision_id,created_by,capability_id,capability_version,route_id,state,invocation,request_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,'motion','1','local',$7,'{}',$8,$9)",[id,workspaceId,projectId,workerId,revisionId,userId,state,hex("e"),randomUUID()]);
    return id;
  }
  function receipt():MotionMediaReceipt{return {schema:"comfyfield/motion-media-receipt",version:1,workspaceId,sourceKey:storageKey,sourceSha256:hex("a"),sourceBytes:100,
    normalizedKey:`${workspaceId}/${randomUUID()}`,normalizedSha256:hex("b"),normalizedBytes:80,width:160,height:96,decodedFrameCount:24,fps:24,
    rFrameRate:"24/1",avgFrameRate:"24/1",timeBase:"1/12288",durationSeconds:1,durationRational:{numerator:24,denominator:24},durationMicroseconds:1_000_000,
    startTimeSeconds:0,firstFramePtsMicroseconds:0,sampleAspectRatio:"1:1",rotationDegrees:0,hasAudio:false,streamCount:1,codec:"h264",container:"mp4",
    containerFormatName:"mov,mp4",pixelFormat:"yuv420p",timingDigest:hex("c"),normalizationVersion:1,normalization:MOTION_NORMALIZATION,
    ffmpegVersion:"fixture",ffprobeVersion:"fixture"};}

  it("runs migration 005, fences expired owners, recovers pre-POST state and persists the single POST marker",async()=>{
    const runId=await run(),ledger=new PgMotionLedgerStore(pool),source={assetId,storageKey,sha256:hex("a"),bytes:100};
    await ledger.ensure(workspaceId,runId,source);
    expect(await ledger.claim(workspaceId,runId,"old",new Date(Date.now()-1000))).toBeTruthy();
    expect(await ledger.claim(workspaceId,runId,"replacement",new Date(Date.now()+60_000))).toBeTruthy();
    await ledger.resetPending(workspaceId,runId,"late old owner","old");
    expect(await ledger.get(workspaceId,runId)).toMatchObject({state:"preparing",leaseOwner:"replacement"});
    const frozen=receipt();expect(await ledger.publishPrepared(workspaceId,runId,"replacement",frozen)).toBe("published");
    await pool.query("UPDATE runs SET state='submitting' WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);
    expect(await ledger.resetSubmittingToPending(workspaceId,runId)).toBe(true);
    await pool.query("UPDATE runs SET state='submitting' WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);
    let posts=0;
    await expect(postMotionPrompt(ledger,workspaceId,runId,{},hex("f"),async()=>++posts)).resolves.toEqual({kind:"posted",value:1});
    await expect(postMotionPrompt(ledger,workspaceId,runId,{},hex("f"),async()=>++posts)).resolves.toEqual({kind:"blocked",reason:"already"});
    expect(posts).toBe(1);
    expect(await ledger.get(workspaceId,runId)).toMatchObject({state:"submitted",graphDigest:hex("f")});
  });

  it("atomically finalizes a restarted cancellation proven to be pre-POST",async()=>{
    const runId=await run(),ledger=new PgMotionLedgerStore(pool),source={assetId,storageKey,sha256:hex("a"),bytes:100},frozen=receipt();
    await ledger.ensure(workspaceId,runId,source);await ledger.claim(workspaceId,runId,"owner",new Date(Date.now()+60_000));
    await ledger.publishPrepared(workspaceId,runId,"owner",frozen);
    await pool.query("UPDATE runs SET state='cancel_requested' WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);
    await expect(ledger.finalizePrePostCancellation(workspaceId,runId)).resolves.toBe(frozen.normalizedKey);
    expect((await pool.query("SELECT state FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,runId])).rows[0].state).toBe("canceled");
    expect(await ledger.get(workspaceId,runId)).toMatchObject({state:"canceled",postAttemptedAt:null});
  });
});
