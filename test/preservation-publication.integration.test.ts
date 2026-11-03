import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {mkdtemp,writeFile} from "node:fs/promises";
import {Readable} from "node:stream";
import sharp from "sharp";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {migrate} from "../server/db";
import {loadServerCatalogue} from "../server/catalogue";
import type {CapabilityBundle} from "../src/capabilities/types";

describe.skipIf(!process.env.TEST_DATABASE_URL)("precision artifact publication and drift authorization",()=>{
  const schema=`cf_preservation_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,worker:Server,bundle:CapabilityBundle;
  let workspaceId:string,projectId:string,workerId:string,userId:string,cookie:string,sourceId:string,maskId:string,runId:string;
  let report=true,historyHits=0;const files=new Map<string,Buffer>();
  const base=()=>`/api/v1/workspaces/${workspaceId}`;
  const api=(method:"GET"|"POST",tail:string,payload?:unknown)=>server.app.inject({method,url:base()+"/"+tail,headers:{origin,cookie},payload:payload as any});
  const png=(data:Buffer,width=16,height=16)=>sharp(data,{raw:{width,height,channels:3}}).png().toBuffer();
  const body=(mask=maskId)=>({projectId,workerId,idempotencyKey:randomUUID(),capabilityId:bundle.manifest.id,version:bundle.manifest.version,routeId:"local",inputs:{source_image:sourceId,edit_mask:mask},controls:{prompt:"Change only the selected object",steps:4,seed:9,mask_mode:"replace"},audioPolicy:"mute"});
  async function asset(bytes:Buffer,semantic:"image"|"mask"){
    const image=await sharp(bytes).metadata(),stored=await server.store.put(workspaceId,Readable.from(bytes)),id=randomUUID();
    await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by,metadata) VALUES($1,$2,$3,'fixture.png',$4,'image/png',$5,$6,$7,$8,$9)",[id,workspaceId,projectId,semantic,stored.key,stored.sha256,stored.bytes,userId,JSON.stringify({imageValidation:{validationVersion:1,format:"png",width:image.width,height:image.height,hasAlpha:false,semantic}})]);
    return id;
  }
  beforeAll(async()=>{
    root=new Pool({connectionString:process.env.TEST_DATABASE_URL});await root.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});await migrate(pool);
    const boot=await bootstrap(pool,"preservation@example.test","Fixture-password-only-123!","Preservation");workspaceId=boot.workspaceId;userId=boot.userId;
    bundle=(await loadServerCatalogue()).find(b=>b.manifest.id==="flux2-klein-preserve-edit")!;
    const original=Buffer.alloc(16*16*3,100),final=Buffer.from(original),mask=Buffer.alloc(original.length);
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){const p=(y*16+x)*3;mask[p]=mask[p+1]=mask[p+2]=255;final[p]=180;}
    final[final.length-3]=120;
    files.set("original.png",await png(original));files.set("candidate.png",await png(final));files.set("final.png",await png(final));files.set("mask.png",await png(mask));
    worker=createServer((req,res)=>{
      if(req.url?.startsWith("/view?")){res.setHeader("content-type","image/png");res.end(files.get(new URL(req.url,"http://local").searchParams.get("filename")!)!);return;}
      res.setHeader("content-type","application/json");
      if(req.url?.startsWith("/history/")){
        historyHits++;const outputs:Record<string,unknown>={};
        for(const [node,name] of [["9","final.png"],["485","candidate.png"],["487","mask.png"]])outputs[node]={images:[{filename:name,subfolder:"",type:"output"}]};
        if(report)outputs["488"]={text:["Upstream fixture report: custom mask replace"]};
        res.end(JSON.stringify({fixture:{outputs,status:{completed:true,status_str:"success"}}}));
      }else res.end(JSON.stringify({queue_running:[],queue_pending:[]}));
    });await new Promise<void>(resolve=>worker.listen(0,"127.0.0.1",resolve));
    server=await buildServer({databaseUrl:process.env.TEST_DATABASE_URL!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-platform/preservation-"),masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool,{catalogue:[bundle]});await server.app.ready();
    const login=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email:"preservation@example.test",password:"Fixture-password-only-123!"}});cookie=String(login.headers["set-cookie"]).split(";")[0];
    projectId=(await api("POST","projects",{name:"Precision fixture"})).json().id;
    workerId=(await api("POST","workers",{name:"Fixture worker",origin:`http://127.0.0.1:${(worker.address() as {port:number}).port}`,apiPrefix:""})).json().id;
    const req=bundle.manifest.routes[0].requirements;
    await pool.query("UPDATE workers SET inventory=$1,checked_at=now() WHERE id=$2",[JSON.stringify({online:true,nodes:req.filter(r=>r.kind==="node").map(r=>r.name),models:req.filter(r=>r.kind==="model").map(r=>`${r.location}/${r.name}`),credentials:[]}),workerId]);
    sourceId=await asset(files.get("original.png")!,"image");maskId=await asset(files.get("mask.png")!,"mask");
  });
  afterAll(async()=>{await server?.execution.close();await server?.app.close();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
  it("publishes all artifacts, retains the real report/measurement and checks drift content",async()=>{
    const admitted=await api("POST","runs",body());expect(admitted.statusCode,admitted.body).toBe(200);runId=admitted.json().id;
    // Isolate publication from generation: the real worker path is covered by
    // scripts/precision-edit-e2e.mjs; this worker returns controlled PNGs.
    await pool.query("UPDATE runs SET state='queued',remote_id='fixture',graph=$1 WHERE id=$2",[JSON.stringify(bundle.template),runId]);
    await server.execution.tick();const run=(await api("GET",`runs/${runId}`)).json();expect(run.state).toBe("succeeded");expect(run.output_ids).toHaveLength(3);
    const final=(await api("GET",`assets/${run.output_ids[0]}`)).json();
    expect(final.metadata.preservation).toMatchObject({sourceAssetId:sourceId,finalAssetId:final.id,report:"Upstream fixture report: custom mask replace",qa:{protectedPixels:192,changedProtectedPixels:1,withinTolerance:false}});
    const drift=await api("GET",`runs/${runId}/preservation/drift`);expect(drift.statusCode).toBe(200);
    const pixels=await sharp(drift.rawPayload).greyscale().raw().toBuffer();expect(pixels[0]).toBe(0);expect(pixels[255]).toBe(255);
    expect((await server.app.inject({url:base()+`/runs/${runId}/preservation/drift`})).statusCode).toBe(401);
    const before=historyHits;await server.execution.tick();expect(historyHits).toBe(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM assets WHERE id=ANY($1::uuid[])",[run.output_ids])).rows[0].n).toBe(3);
  });
  it("rejects all-white/all-black manual masks before creating a run",async()=>{
    for(const value of [0,255]){
      const mask=await asset(await png(Buffer.alloc(16*16*3,value)),"mask");const before=(await pool.query("SELECT count(*) FROM runs")).rows[0].count;
      const response=await api("POST","runs",body(mask));expect(response.statusCode).toBe(422);expect(response.json().error).toContain("selected and protected");
      expect((await pool.query("SELECT count(*) FROM runs")).rows[0].count).toBe(before);
    }
  });
  it("does not publish image artifacts without their upstream preservation report",async()=>{
    report=false;
    try{
      const before=(await pool.query("SELECT count(*) FROM assets")).rows[0].count;
      const admitted=await api("POST","runs",body());expect(admitted.statusCode).toBe(200);
      const id=admitted.json().id;
      await pool.query("UPDATE runs SET state='queued',remote_id='fixture',graph=$1 WHERE id=$2",[JSON.stringify(bundle.template),id]);
      await server.execution.tick();const run=(await api("GET",`runs/${id}`)).json();
      expect(run.state).toBe("failed");expect(run.output_ids).toEqual([]);
      expect((await pool.query("SELECT count(*) FROM assets")).rows[0].count).toBe(before);
    }finally{report=true;}
  });
  it("rejects tampered published media instead of returning a misleading overlay",async()=>{
    const source=(await pool.query("SELECT storage_key FROM assets WHERE id=$1",[sourceId])).rows[0];await writeFile(await server.store.file(workspaceId,source.storage_key),"tampered");
    expect((await api("GET",`runs/${runId}/preservation/drift`)).statusCode).toBe(422);
  });
});
