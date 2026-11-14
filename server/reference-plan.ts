import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member} from "./auth";
import {comfyGenerate,extractJsonObject,type Worker} from "./storyboard-plan";
import {heuristicPlan,planProblems,plannerInstruction,referencePlanSchema,referencedLabels,type ReferencePlan} from "../src/workflow/reference-prompt";

const requestSchema=z.object({prompt:z.string().trim().min(5).max(4000),faces:z.number().int().min(1).max(4).optional()}).strict();

/** A local model's plan, only if it is valid JSON of the right shape that uses only the prompt's own references. */
export function acceptModelPlan(text:string,prompt:string):ReferencePlan|null{
  try{
    const plan=referencePlanSchema.safeParse(JSON.parse(extractJsonObject(text)));
    return plan.success&&!planProblems(plan.data,prompt).length?plan.data:null;
  }catch{return null;}
}

/** The prompt a plan is read from. A plain sentence names no reference, so it is read against the faces on
 *  screen: one face means it is about that person ("make him wear a red jacket"); more than one means it has
 *  to name the face (@Image 2). A face this screen does not have, and any other prompt that cannot be read,
 *  comes back as `problems` instead of a plan that would change nothing. */
export function planPrompt(prompt:string,faces?:number):{prompt:string;problems:string[]}{
  const labels=referencedLabels(prompt);
  const images=labels.flatMap(label=>label.startsWith("@Image")?[Number(label.slice(7))]:[]);
  const outside=images.filter(n=>!!faces&&n>faces);
  if(outside.length)return {prompt,problems:[`There is no ${outside.map(n=>`@Image ${n}`).join(" or ")} here.`]};
  if(labels.some(label=>label.startsWith("@Video")))return {prompt,problems:[]};
  if(images.length)return {prompt:`@Video 1 ${prompt}`,problems:[]};
  if(faces===1)return {prompt:`@Video 1 @Image 1 ${prompt}`,problems:[]};
  return {prompt,problems:[faces&&faces>1?"Say which face to change, like @Image 1.":"Mention the source clip as @Video 1."]};
}

/** Turns a sentence or an @-reference request into a per-person plan for review. Nothing is generated here. */
export async function referencePlanRoutes(app:FastifyInstance,pool:Pool){
  app.post("/api/v1/workspaces/:workspaceId/reference-plan",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId,"creator");
    const {prompt,faces}=requestSchema.parse(request.body??{});
    const references=referencedLabels(prompt),read=planPrompt(prompt,faces);
    if(read.problems.length)return {references,plan:null,source:"none",problems:read.problems};
    const worker=(await pool.query("SELECT origin,api_prefix FROM workers WHERE workspace_id=$1 AND enabled=true ORDER BY checked_at DESC NULLS LAST,id LIMIT 1",[workspaceId])).rows[0] as Worker|undefined;
    if(worker){
      try{
        const answer=await comfyGenerate(worker,plannerInstruction(read.prompt));
        const plan=acceptModelPlan(answer.text,read.prompt);
        if(plan)return {references,plan,source:answer.model,problems:[]};
      }catch{/* no local text model: fall back to the rule-based plan below */}
    }
    const plan=heuristicPlan(read.prompt);
    return {references,plan,source:"rules",problems:plan?planProblems(plan,read.prompt):["Could not read a plan from this prompt."]};
  });
}
