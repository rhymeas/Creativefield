import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {member} from "./auth";
import {generateText} from "./ai-text";
import {extractJsonObject} from "./storyboard-plan";
import {editPlanProblems,editPlannerInstruction,editPlanSchema,heuristicEditPlan,type EditPlan,type EditRead} from "../src/workflow/edit-plan";

const requestSchema=z.object({
  prompt:z.string().max(4000),
  images:z.number().int().min(0).max(8),
}).strict();

/** A model's read, only if it is valid JSON of the right shape that finds a trackable target and uses only
 *  pictures this screen has. */
export function acceptModelEditPlan(text:string,images:number):EditPlan|null{
  try{
    const plan=editPlanSchema.safeParse(JSON.parse(extractJsonObject(text)));
    return plan.success&&!editPlanProblems(plan.data,images).length?plan.data:null;
  }catch{return null;}
}

/** Reads one edit sentence ("make his jacket red", "replace the mug with @Image 1") into what SAM 3.1 should
 *  track and what VACE should paint there. The rules answer first, so this works with no AI configured; the
 *  workspace's text model is asked only when the rules cannot read the sentence. Nothing is queued here. */
export async function editPlanRoutes(app:FastifyInstance,pool:Pool){
  app.post("/api/v1/workspaces/:workspaceId/edit-plan",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId);
    const {prompt,images}=requestSchema.parse(request.body??{});
    const read:EditRead=heuristicEditPlan(prompt,images);
    if(!read.problems.length||!prompt.trim())return read;
    try{
      const answer=await generateText("active",{workspaceId,system:editPlannerInstruction(images),prompt:`Sentence: ${prompt}`,maxTokens:300,json:true},{pool});
      const plan=acceptModelEditPlan(answer.text,images);
      if(plan)return {...plan,problems:[]};
    }catch{/* no text model here: the rules' own answer stands */}
    return read;
  });
}
