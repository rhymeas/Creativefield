import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {Pool} from "pg";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildServer} from "../server/app";
import {bootstrap} from "../server/auth";
import {hashPassword} from "../server/crypto";
import {migrate} from "../server/db";
import {docFromImage,emptyDoc,GROUP_DEPTH_LIMIT} from "../src/image/editor/doc";
import {DOCUMENT_FORMAT,validateDocument,documentKeys,mapDocumentKeys} from "../src/image/editor/document-format";

const connectionString=process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)("layered editor persistence",()=>{
  const schema=`cf_docs_${randomUUID().replaceAll("-","")}`,origin="http://localhost:5173",password="Fixture-only-Docs-527!";
  let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,storageRoot:string,workspaceId:string,ownerId:string,projectId:string,otherProject:string,assetId:string,cookie:string,viewerCookie:string;
  const url=(id?:string,project=projectId)=>`/api/v1/workspaces/${workspaceId}/projects/${project}/editor-documents${id?`/${id}`:""}`;
  const request=(method:"GET"|"PUT"|"DELETE",path:string,payload?:unknown,session=cookie)=>server.app.inject({method,url:path,headers:{origin,cookie:session},payload:payload as object});
  beforeAll(async()=>{
    root=new Pool({connectionString});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema}`});await migrate(pool);
    storageRoot=await mkdtemp(join(process.env.COMFYFIELD_TEST_TEMP_ROOT??tmpdir(),"comfyfield-docs-"));
    const owner=await bootstrap(pool,"docs@example.test",password,"Documents");workspaceId=owner.workspaceId;ownerId=owner.userId;
    const viewer=randomUUID();await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,'docs-viewer@example.test',$2)",[viewer,await hashPassword(password)]);
    await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[workspaceId,viewer]);
    server=await buildServer({databaseUrl:connectionString!,storageRoot,masterKey:randomBytes(32),publicOrigin:origin,host:"127.0.0.1",port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool);await server.app.ready();
    for(const email of ["docs@example.test","docs-viewer@example.test"]){const r=await server.app.inject({method:"POST",url:"/api/v1/auth/login",headers:{origin},payload:{email,password}});expect(r.statusCode).toBe(200);const c=String(r.headers["set-cookie"]).split(";")[0];if(email.startsWith("docs@"))cookie=c;else viewerCookie=c;}
    projectId=randomUUID();otherProject=randomUUID();await pool.query("INSERT INTO projects(id,workspace_id,name,created_by) VALUES($1,$3,'Editing',$4),($2,$3,'Other',$4)",[projectId,otherProject,workspaceId,ownerId]);
    assetId=randomUUID();await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'layer.png','layer','image/png',$4,$5,10,$6)",[assetId,workspaceId,projectId,`${workspaceId}/${assetId}`,"a".repeat(64),ownerId]);
  },30000);
  afterAll(async()=>{await server?.app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}if(storageRoot)await rm(storageRoot,{recursive:true,force:true});});
  it("retains layers, selections, masks and smart-object references with optimistic revisions",async()=>{
    const doc=docFromImage("Original",`asset:${assetId}`,64,64);doc.selection=`asset:${assetId}`;doc.layers[0].mask=`asset:${assetId}`;doc.layers[0].defringe=1;doc.layers[0].smartObject=docFromImage("Nested",`asset:${assetId}`,32,32);
    doc.groups={outer:{name:"Outer",visible:true,opacity:.5},inner:{name:"Inner",visible:true,parent:"outer"}};doc.layers[0].group="inner";
    const id=randomUUID(),body={format:DOCUMENT_FORMAT,name:"Editable",kind:"saved",revision:0,document:doc};
    const first=await request("PUT",url(id),body);expect(first.statusCode).toBe(200);expect(first.json().revision).toBe(1);
    expect((await request("GET",url(id))).json().document).toEqual(doc);
    expect((await request("PUT",url(id),body)).statusCode).toBe(409);
    expect((await request("PUT",url(id),{...body,revision:1})).json().revision).toBe(2);
    expect((await request("GET",url(id,otherProject))).statusCode).toBe(404);
  });
  it("rejects foreign-project pixels, malformed references and unauthorized writes",async()=>{
    const doc=docFromImage("Original",`asset:${assetId}`,64,64),body={format:DOCUMENT_FORMAT,name:"Editable",kind:"saved",revision:0,document:doc};
    expect((await request("PUT",url(randomUUID(),otherProject),body)).statusCode).toBe(422);
    expect((await request("PUT",url(randomUUID()),body,viewerCookie)).statusCode).toBe(403);
    expect((await request("PUT",url(randomUUID()),{...body,document:{...doc,layers:[{...doc.layers[0],src:"https://example.test/image.png"}]}})).statusCode).toBe(422);
    expect((await request("PUT",url(randomUUID()),{...body,document:{...doc,width:1e12}})).statusCode).toBe(422);
  });
  it("keeps recovery drafts private to their author while exposing saved documents to project readers",async()=>{
    const doc=docFromImage("Original",`asset:${assetId}`,64,64),id=randomUUID();
    expect((await request("PUT",url(id),{format:DOCUMENT_FORMAT,name:"Draft",kind:"recovery",revision:0,document:doc})).statusCode).toBe(200);
    expect((await request("GET",url(id),undefined,viewerCookie)).statusCode).toBe(404);
    expect((await request("GET",url(),undefined,viewerCookie)).json().every((r:{kind:string})=>r.kind==="saved")).toBe(true);
  });
  it("protects even a blank saved document from project deletion",async()=>{
    expect((await request("PUT",url(randomUUID(),otherProject),{format:DOCUMENT_FORMAT,name:"Blank",kind:"saved",revision:0,document:emptyDoc(64,64)})).statusCode).toBe(200);
    expect((await request("DELETE",`/api/v1/workspaces/${workspaceId}/projects/${otherProject}`)).statusCode).toBe(409);
  });
  it("filters backing pixels and media kind before pagination without blocking direct authorized reads",async()=>{
    await pool.query("UPDATE assets SET metadata='{\"editorDocumentBitmap\":true}' WHERE id=$1",[assetId]);
    const listing=await request("GET",`/api/v1/workspaces/${workspaceId}/assets?projectId=${projectId}&kind=layer&limit=1`);
    expect(listing.statusCode).toBe(200);expect(listing.json().items).toEqual([]);
    const included=await request("GET",`/api/v1/workspaces/${workspaceId}/assets?projectId=${projectId}&kind=layer&includeDocumentBitmaps=true&limit=1`);
    expect(included.json().items.map((a:{id:string})=>a.id)).toContain(assetId);
    expect((await request("GET",`/api/v1/workspaces/${workspaceId}/assets/${assetId}`)).statusCode).toBe(200);
    await pool.query("UPDATE assets SET metadata='{}' WHERE id=$1",[assetId]);
  });
});
describe("layered document codec",()=>{
  it("maps every nested bitmap and rejects over-deep objects and missing active layers",()=>{
    const key=`asset:${randomUUID()}`,doc=docFromImage("Source",key,64,64);doc.saved=[{id:"s",name:"Area",key}];doc.layers[0].smartObject=docFromImage("Nested",key,32,32);
    const gid="group-test";doc.groups={[gid]:{name:"Shots",visible:true,opacity:.35,blend:"multiply"}};doc.layers[0].group=gid;
    expect(documentKeys(doc)).toEqual([key]);expect(validateDocument(doc)).toEqual(doc);
    const other=`asset:${randomUUID()}`;expect(documentKeys(mapDocumentKeys(doc,()=>other))).toEqual([other]);
    expect(()=>validateDocument({...doc,selectedId:"missing"})).toThrow();
    let parent=doc;for(let i=0;i<10;i++){const child=docFromImage("Child",key,32,32);parent.layers[0].smartObject=child;parent=child;}
    expect(()=>validateDocument(doc)).toThrow(/nesting/);
  });
  it("round trips nested groups and rejects missing or cyclic parents",()=>{
    const key=`asset:${randomUUID()}`,doc=docFromImage("Source",key,64,64);
    const groups={outer:{name:"Outer",visible:true},inner:{name:"Inner",visible:true,parent:"outer"}};doc.groups=groups;
    doc.layers[0].group="inner";
    expect(validateDocument(doc).groups).toEqual(groups);
    expect(()=>validateDocument({...doc,groups:{...groups,inner:{...groups.inner,parent:"missing"}}})).toThrow(/parent/);
    expect(()=>validateDocument({...doc,groups:{outer:{...groups.outer,parent:"inner"},inner:groups.inner}})).toThrow(/cyclic/);
    const chain=Object.fromEntries(Array.from({length:GROUP_DEPTH_LIMIT},(_,index)=>[`g${index}`,{name:"Folder",visible:true,...(index?{parent:`g${index-1}`}:{})}]));
    const deepest={...doc,groups:chain,layers:doc.layers.map(layer=>({...layer,group:`g${GROUP_DEPTH_LIMIT-1}`}))};
    expect(()=>validateDocument(deepest)).not.toThrow();
    expect(()=>validateDocument({...deepest,groups:{...chain,outermost:{name:"Extra",visible:true},g0:{...chain.g0,parent:"outermost"}}})).toThrow(/sixteen/);
  });
});
