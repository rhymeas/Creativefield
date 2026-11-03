import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {Readable} from 'node:stream';
import sharp from 'sharp';
import {buildServer} from '../server/app';
import {bootstrap} from '../server/auth';
import {migrate} from '../server/db';
import {hashPassword} from '../server/crypto';
import {type ChatgptNative,CHATGPT_IMAGE_MODEL} from '../server/chatgpt-native';
import {ChatgptImageService} from '../server/chatgpt-images';

const database=process.env.TEST_DATABASE_URL;
async function within(promise:Promise<void>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Mock native job did not start within five seconds')),5000);})]);}finally{clearTimeout(timer);}}
 describe.skipIf(!database)('user-owned ChatGPT accounts and background image jobs (mocked native CLI; zero inference)',()=>{
 const schema=`cf_chatgpt_${randomUUID().replaceAll('-','')}`,origin='http://localhost:5173';
 let root:Pool,pool:Pool,server:Awaited<ReturnType<typeof buildServer>>,workspace:string,project:string,cookie:string,otherCookie:string,user:string,otherUser:string,png:Buffer,source:string,edits=0,mode='ok',entered:()=>void=()=>{},release:()=>void=()=>{};
 const accounts=new Set<string>(),pending=new Map<string,(ok:boolean)=>void>();let inspected:{home:string;paths:string[];prompt:string}[]=[];
 const native:ChatgptNative={
  async status(home){return {connected:accounts.has(home),email:`${basename(home)}@fixture.test`,plan:'fixture'};},
  async login(home,complete){pending.set(home,complete);return {loginId:randomUUID(),verificationUrl:'https://auth.openai.com/codex/device',userCode:basename(home).slice(0,8),close:async()=>{pending.delete(home);}};},
  async logout(home){accounts.delete(home);},
  async edit(home,_cwd,paths,prompt,signal){edits++;inspected.push({home,paths,prompt});entered();if(mode==='hold')await new Promise<void>((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(new Error('canceled')),{once:true});});if(mode==='fail')throw new Error('Fixture quota limit; no retry.');return {bytes:mode==='bad'?Buffer.from('not an image'):png,model:CHATGPT_IMAGE_MODEL,runtime:'fixture-0.164'};},
 };
 const api=(method:'GET'|'POST'|'DELETE',tail:string,payload?:unknown,auth=cookie,ws=workspace)=>server.app.inject({method,url:`/api/v1/workspaces/${ws}/${tail}`,headers:{origin,cookie:auth},payload:payload as any});
 const request=()=>({projectId:project,idempotencyKey:randomUUID(),feature:'image-edit',inputs:{source_image:source},prompt:'Change the square to orange',consent:{subscriptionQuota:true}});
 async function signedIn(id=user){const home=await server.chatgptImages.profile(id);accounts.add(home);await writeFile(join(home,'auth.json'),'{"fixture":"no real credentials"}');return home;}
 async function run(body:unknown=request()){const response=await api('POST','chatgpt-image/runs',body);expect(response.statusCode,response.body).toBe(200);await server.chatgptImages.settled(response.json().id);return (await api('GET',`runs/${response.json().id}`)).json();}
 beforeAll(async()=>{
  root=new Pool({connectionString:database});await root.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString:database,options:`-c search_path=${schema}`});await migrate(pool);
  workspace=(await bootstrap(pool,'native@fixture.test','Fixture-password-long-27!','Native tests')).workspaceId;
  await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),'second@fixture.test',await hashPassword('Fixture-password-long-27!')]);
  user=(await pool.query('SELECT id FROM users WHERE email=$1',['native@fixture.test'])).rows[0].id;otherUser=(await pool.query('SELECT id FROM users WHERE email=$1',['second@fixture.test'])).rows[0].id;
  await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'creator')",[workspace,otherUser]);
  server=await buildServer({databaseUrl:database!,storageRoot:await mkdtemp((process.env.COMFYFIELD_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? process.env.TEMP ?? "/tmp") + "/comfyfield-native-test-"),masterKey:randomBytes(32),publicOrigin:origin,host:'127.0.0.1',port:8787,sessionTtlHours:1,inviteTtlHours:1,maxUploadBytes:1024*1024,cookieSecure:false},pool,{catalogue:[],chatgptNative:native});await server.app.ready();
  async function login(email:string){const r=await server.app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin},payload:{email,password:'Fixture-password-long-27!'}});return String(r.headers['set-cookie']).split(';')[0];}
  cookie=await login('native@fixture.test');otherCookie=await login('second@fixture.test');project=(await api('POST','projects',{name:'Native project'})).json().id;
  png=await sharp({create:{width:16,height:16,channels:3,background:'orange'}}).png().toBuffer();const saved=await server.store.put(workspace,Readable.from(png));source=randomUUID();
  await pool.query("INSERT INTO assets(id,workspace_id,project_id,name,media_type,content_type,storage_key,sha256,bytes,created_by) VALUES($1,$2,$3,'Original','image','image/png',$4,$5,$6,$7)",[source,workspace,project,saved.key,saved.sha256,saved.bytes,user]);
 });
 beforeEach(async()=>{edits=0;mode='ok';inspected=[];entered=()=>{};release=()=>{};await signedIn();await pool.query("UPDATE memberships SET role='creator' WHERE workspace_id=$1 AND user_id=$2",[workspace,otherUser]);});
 afterAll(async()=>{await server?.app.close();await pool?.end();if(root){await root.query(`DROP SCHEMA ${schema} CASCADE`);await root.end();}});
 it('uses independent user profiles, reuses only that user’s pending sign-in and never reveals desktop tokens',async()=>{
  await api('POST','chatgpt-image/logout');const a=await api('POST','chatgpt-image/login'),again=await api('POST','chatgpt-image/login'),b=await api('POST','chatgpt-image/login',{},otherCookie);
  expect(a.json()).toEqual(again.json());expect(b.json().userCode).not.toBe(a.json().userCode);expect(pending.size).toBe(2);expect(a.body).not.toContain('auth.json');expect(a.body).not.toContain('access_token');
  await api('POST','chatgpt-image/login/cancel');expect(pending.size).toBe(1);expect((await api('GET','chatgpt-image/account',undefined,otherCookie)).json().pending).toBe(true);await api('POST','chatgpt-image/login/cancel',{},otherCookie);
  expect(edits).toBe(0);
 });
 it('reads and disconnects only the caller’s own native account',async()=>{const otherHome=await signedIn(otherUser);expect((await api('GET','chatgpt-image/account')).json().connected).toBe(true);await api('POST','chatgpt-image/logout');expect((await api('GET','chatgpt-image/account')).json().connected).toBe(false);expect(accounts.has(otherHome)).toBe(true);expect((await api('GET','chatgpt-image/account',undefined,otherCookie)).json().email).toContain(otherUser);expect(edits).toBe(0);});
 it('finishes a managed device login without an inference request',async()=>{await api('POST','chatgpt-image/logout');await api('POST','chatgpt-image/login');const home=await signedIn();const complete=pending.get(home)!;pending.delete(home);complete(true);expect((await api('GET','chatgpt-image/account')).json()).toMatchObject({connected:true,pending:false});expect(edits).toBe(0);});
 it('requires quota consent, source ownership, supported feature and no client model override',async()=>{const body=request();for(const bad of [{...body,consent:{}},{...body,feature:'video-edit'},{...body,model:'other'},{...body,projectId:randomUUID()},{...body,inputs:{source_image:randomUUID()}}])expect((await api('POST','chatgpt-image/runs',bad)).statusCode).toBeGreaterThanOrEqual(400);expect(edits).toBe(0);});
 it('publishes one decoded image into the same project, keeps source bytes and deduplicates lost acknowledgements',async()=>{
  const body=request(),response=await api('POST','chatgpt-image/runs',body),again=await api('POST','chatgpt-image/runs',body);expect(response.statusCode,response.body).toBe(200);expect(again.json().id).toBe(response.json().id);await server.chatgptImages.settled(response.json().id);
  const row=(await api('GET',`runs/${response.json().id}`)).json();expect(row.state).toBe('succeeded');expect(row.transport).toBe('chatgpt');expect(row.invocation.native).toMatchObject({model:CHATGPT_IMAGE_MODEL,accountUserId:user});expect(edits).toBe(1);
  const asset=(await api('GET',`assets/${row.output_ids[0]}`)).json();expect(asset).toMatchObject({project_id:project,parent_id:source,content_type:'image/png',metadata:{width:16,height:16,provider:'chatgpt'}});
  expect(await readFile(await server.store.file(workspace,(await pool.query('SELECT storage_key FROM assets WHERE id=$1',[source])).rows[0].storage_key))).toEqual(png);
  expect((await api('POST','chatgpt-image/runs',body,otherCookie)).statusCode).toBe(409);expect(edits).toBe(1);
 });
 it('supplies the source before references and keeps each job’s files in its own profile',async()=>{const result=await run({...request(),inputs:{source_image:source,reference_image:source,reference_image_2:source}});expect(result.state).toBe('succeeded');expect(inspected[0].paths.map(p=>basename(p))).toEqual(['source_image.png','reference_image.png','reference_image_2.png']);expect(inspected[0].home).toContain(user);expect(inspected[0].paths.every(p=>p.startsWith(inspected[0].home))).toBe(true);});
 it('cancels an active native process through the shared run control; another creator cannot cancel it',async()=>{mode='hold';let ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});entered=ready;const response=await api('POST','chatgpt-image/runs',request());await within(started);
  expect((await api('POST',`runs/${response.json().id}/cancel`,{},otherCookie)).statusCode).toBe(403);const canceled=await api('POST',`runs/${response.json().id}/cancel`,{});expect(canceled.json().state).toBe('canceled');expect((await api('GET',`runs/${response.json().id}`)).json().output_ids).toEqual([]);expect(edits).toBe(1);
 });
 it('revokes pending output on disconnect and keeps another user’s credentials',async()=>{const otherHome=await signedIn(otherUser);mode='hold';let ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});entered=ready;const response=await api('POST','chatgpt-image/runs',request());await within(started);expect((await api('POST','chatgpt-image/logout')).statusCode).toBe(200);expect((await api('GET',`runs/${response.json().id}`)).json()).toMatchObject({state:'canceled',output_ids:[]});expect(accounts.has(otherHome)).toBe(true);expect(edits).toBe(1);});
 it('does not publish after workspace permission revocation, even if the native tool returns an image',async()=>{await signedIn(otherUser);mode='hold';let ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});entered=ready;const response=await api('POST','chatgpt-image/runs',request(),otherCookie);await within(started);await pool.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,otherUser]);release();await server.chatgptImages.settled(response.json().id);expect((await api('GET',`runs/${response.json().id}`)).json()).toMatchObject({state:'failed',output_ids:[]});});
 it('refuses image requests from viewers or another workspace',async()=>{await pool.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[workspace,otherUser]);expect((await api('POST','chatgpt-image/runs',request(),otherCookie)).statusCode).toBe(403);expect((await api('GET','chatgpt-image/account',undefined,cookie,randomUUID())).statusCode).toBe(403);expect(edits).toBe(0);});
 it('rejects a completed output after the pinned account revision changes',async()=>{mode='hold';let ready!:()=>void;const started=new Promise<void>(r=>{ready=r;});entered=ready;const response=await api('POST','chatgpt-image/runs',request());await within(started);await pool.query('UPDATE chatgpt_image_accounts SET revision=revision+1 WHERE user_id=$1',[user]);release();await server.chatgptImages.settled(response.json().id);expect((await api('GET',`runs/${response.json().id}`)).json()).toMatchObject({state:'failed',output_ids:[]});});
 it('retains failures and invalid outputs without an implicit second turn',async()=>{mode='fail';const body=request(),failed=await run(body);expect(failed.state).toBe('failed');expect(failed.error).toContain('quota');await api('POST','chatgpt-image/runs',body);expect(edits).toBe(1);mode='bad';const invalid=await run();expect(invalid).toMatchObject({state:'failed',output_ids:[]});expect(edits).toBe(2);});
 it('recovers an interrupted job without inference and does not take over another process’s runner',async()=>{const id=randomUUID();await pool.query("INSERT INTO runs(id,workspace_id,project_id,created_by,capability_id,capability_version,route_id,state,transport,invocation,request_hash,idempotency_key) VALUES($1,$2,$3,$4,'chatgpt-image-edit','1.0.0','chatgpt-native','running','chatgpt','{}','fixture',$5)",[id,workspace,project,user,randomUUID()]);const second=new ChatgptImageService(pool,server.store,native);try{await second.recover();expect((await api('GET',`runs/${id}`)).json().state).toBe('running');await server.chatgptImages.close();await second.recover();expect((await api('GET',`runs/${id}`)).json()).toMatchObject({state:'failed',output_ids:[]});expect((await api('GET',`runs/${id}/events`)).json().some((e:any)=>e.state==='failed')).toBe(true);expect(edits).toBe(0);}finally{await second.close();}});
});
