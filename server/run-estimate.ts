import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member} from "./auth";

const querySchema=z.object({runId:z.uuid().optional(),capabilityId:z.string().min(1).max(200).optional(),quality:z.string().max(40).optional(),length:z.string().max(10).optional()}).strict();

/**
 * How long a job like this usually takes here: the median of the last finished runs of the same workflow,
 * with the same quality and length, or failing that the same quality. Another quality is never used: an HD finish takes far longer.
 * Submit to result, so a queue wait counts. Null when nothing comparable has finished yet.
 */
export async function runEstimate(pool:Pool,workspaceId:string,capabilityId:string,quality?:string,length?:string){
  const median=async(withLength:boolean)=>(await pool.query<{seconds:number|null;samples:number}>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float AS seconds,count(*)::int AS samples FROM (
       SELECT extract(epoch FROM updated_at-created_at) AS seconds FROM runs
       WHERE workspace_id=$1 AND capability_id=$2 AND state='succeeded' AND deleted_at IS NULL
         AND coalesce(invocation->'controls'->>'quality','')=coalesce($4,'')
         AND ($3::boolean IS FALSE OR coalesce(invocation->'controls'->>'length','')=coalesce($5,''))
       ORDER BY created_at DESC LIMIT 20) recent WHERE seconds>0`,
    [workspaceId,capabilityId,withLength,quality??null,length??null])).rows[0];
  const exact=await median(true);
  const pick=exact&&exact.samples>0?exact:await median(false);
  return pick&&pick.samples>0&&pick.seconds?{seconds:Math.round(pick.seconds),samples:pick.samples}:null;
}

export async function runEstimateRoutes(app:FastifyInstance,pool:Pool){
  app.get("/api/v1/workspaces/:workspaceId/run-estimate",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId,"viewer");
    const q=querySchema.parse(request.query??{});
    if(q.runId){
      const run=(await pool.query("SELECT capability_id,invocation FROM runs WHERE workspace_id=$1 AND id=$2",[workspaceId,q.runId])).rows[0];
      if(!run)return {estimate:null};
      const c=run.invocation?.controls??{};
      return {estimate:await runEstimate(pool,workspaceId,run.capability_id,c.quality==null?undefined:String(c.quality),c.length==null?undefined:String(c.length))};
    }
    if(!q.capabilityId)return {estimate:null};
    return {estimate:await runEstimate(pool,workspaceId,q.capabilityId,q.quality,q.length)};
  });
}
