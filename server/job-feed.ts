import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member,HttpError} from "./auth";

const activeStates=["pending","submitting","submission_unknown","queued","running","cancel_requested"];
const preparingStates=["pending","preparing","prepared","queued","cancel_requested"];
type Subscriber={authorize:()=>Promise<unknown>;write:(data:string)=>boolean;close:()=>void};
type Group={clients:Set<Subscriber>;timer?:ReturnType<typeof setTimeout>;running:boolean;last?:string;heartbeat:number};
export type JobFeedSnapshot={runs:Record<string,unknown>[];preparations:Record<string,unknown>[];total:number;progress:Record<string,number>};

/** One sequential scheduler per subscribed workspace; no work without listeners. */
export class WorkspaceJobFeed {
  private groups=new Map<string,Group>();
  constructor(private read:(workspace:string)=>Promise<JobFeedSnapshot>){}
  subscribe(workspace:string,client:Subscriber){
    if([...this.groups.values()].reduce((n,g)=>n+g.clients.size,0)>=128||(this.groups.get(workspace)?.clients.size??0)>=16)throw new HttpError(429,"Too many open job connections");
    let group=this.groups.get(workspace);
    if(!group){group={clients:new Set(),running:false,heartbeat:Date.now()};this.groups.set(workspace,group);}
    group.clients.add(client);
    // A new connection needs an initial snapshot even when the data is unchanged.
    group.last=undefined;
    if(group.timer)clearTimeout(group.timer);
    void this.tick(workspace,group);
    return ()=>this.remove(workspace,group!,client);
  }
  private remove(workspace:string,group:Group,client:Subscriber){
    group.clients.delete(client);
    if(!group.clients.size){if(group.timer)clearTimeout(group.timer);if(this.groups.get(workspace)===group)this.groups.delete(workspace);}
  }
  private async tick(workspace:string,group:Group){
    if(group.running||!group.clients.size)return;
    group.running=true;
    try{
      await Promise.all([...group.clients].map(async client=>{
        try{await client.authorize();}
        catch{this.remove(workspace,group,client);client.write('event: access-denied\ndata: {}\n\n');client.close();}
      }));
      if(!group.clients.size)return;
      const snapshot=await this.read(workspace);
      if(!group.clients.size)return;
      const data=JSON.stringify(snapshot),changed=data!==group.last,heartbeat=Date.now()-group.heartbeat>=15000;
      if(changed||heartbeat){
        const frame=changed?`event: jobs\ndata: ${data}\n\n`:': keepalive\n\n';
        for(const client of [...group.clients])if(!client.write(frame)){this.remove(workspace,group,client);client.close();}
        group.last=data;group.heartbeat=Date.now();
      }
      if(group.clients.size)group.timer=setTimeout(()=>void this.tick(workspace,group),snapshot.total?1000:10000);
    }catch{
      for(const client of [...group.clients]){this.remove(workspace,group,client);client.write('event: unavailable\ndata: {}\n\n');client.close();}
    }finally{group.running=false;}
  }
  close(){for(const [workspace,group] of this.groups)for(const client of [...group.clients]){this.remove(workspace,group,client);client.close();}}
}

export function jobFeedRoutes(app:FastifyInstance,pool:Pool,frame:(id:string)=>{value:number|null;max:number|null}|undefined){
  const feed=new WorkspaceJobFeed(async workspace=>{
    // Filter active records before limiting: an old pending job must not vanish
    // behind 200 newer completed jobs. count(*) OVER counts all active jobs.
    const rows=(await pool.query(`SELECT id,project_id,capability_id,state,created_at,updated_at,take,
      -- What the job makes, in one line: the prompt it was given.
      left(regexp_replace(coalesce(invocation->'controls'->>'prompt',invocation->'controls'->>'motion_prompt',''),'\\s+',' ','g'),90) AS subject,
      count(*) OVER()::int AS total
      FROM runs WHERE workspace_id=$1 AND state=ANY($2::text[]) ORDER BY created_at DESC,id DESC LIMIT 8`,[workspace,activeStates])).rows;
    // Pose preparation exists before its child run. Show it in the same feed
    // only while no run_id exists, so the run row never duplicates it.
    const preparations=(await pool.query(`SELECT p.id,p.project_id,p.state,p.created_at,p.updated_at,
      left(a.name,120) AS source_name,count(*) OVER()::int AS total
      FROM pose_previews p LEFT JOIN assets a ON a.workspace_id=p.workspace_id AND a.id=p.source_asset_id
      WHERE p.workspace_id=$1 AND p.run_id IS NULL AND p.state=ANY($2::text[])
      ORDER BY p.created_at DESC,p.id DESC LIMIT 4`,[workspace,preparingStates])).rows;
    const progress:Record<string,number>={};
    for(const row of rows){const current=frame(row.id);if(current?.value!=null&&current.max!=null&&current.max>0){const value=current.value/current.max;if(Number.isFinite(value))progress[row.id]=Math.max(0,Math.min(1,value));}}
    return {runs:rows.map(({total:_,...run})=>run),preparations:preparations.map(({total:_,...preparation})=>preparation),total:(rows[0]?.total??0)+(preparations[0]?.total??0),progress};
  });
  app.get('/api/v1/workspaces/:workspaceId/jobs/stream',async(request,reply)=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId);
    // Reserve capacity before committing streaming headers.
    let unsubscribe:()=>void=()=>{};
    const client:Subscriber={authorize:()=>member(pool,request,workspaceId),write:data=>!reply.raw.destroyed&&reply.raw.write(data),close:()=>reply.raw.end()};
    unsubscribe=feed.subscribe(workspaceId,client);
    reply.raw.once('close',()=>unsubscribe());
    reply.hijack();
    reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
    reply.raw.flushHeaders();
  });
  app.addHook('preClose',async()=>feed.close());
}
