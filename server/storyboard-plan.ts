import type {FastifyInstance} from "fastify";
import type {Pool} from "pg";
import {z} from "zod";
import {HttpError,member} from "./auth";
import {generateText} from "./ai-text";
// reference-plan.ts still asks ComfyUI directly; it moves onto the seam next.
export {comfyGenerate,type Worker} from "./ai-text/local-comfy";

const requestSchema=z.object({
  premise:z.string().trim().min(5).max(4000),
  count:z.number().int().min(1).max(8).default(3),
}).strict();
const shotSchema=z.object({
  title:z.string().trim().min(1).max(120),
  prompt:z.string().trim().min(1).max(1200),
  durationSeconds:z.number().min(1).max(10),
  shotIntent:z.string().trim().max(120).optional(),
  cameraIntent:z.string().trim().max(120).optional(),
});
const planSchema=z.object({shots:z.array(shotSchema).min(1).max(8)}).strict();

/** Small models often wrap JSON in prose or a code fence; take the outermost object, never edit its content. */
export function extractJsonObject(text:string){
  const start=text.indexOf("{"),end=text.lastIndexOf("}");
  return start>=0&&end>start?text.slice(start,end+1):text;
}

export function planSystem(count:number){
  return "You are a film shot planner. Return only strict JSON, no markdown. The object must have a shots array with exactly "+count+" entries. Every entry has title, prompt, durationSeconds, shotIntent and cameraIntent. title is a short card title. prompt is a complete visual generation prompt. durationSeconds is 1 to 10. shotIntent and cameraIntent are short production notes.";
}

/** Parse a model's answer without inventing or repairing shots. */
export function parsePlannedShots(content:string,count:number){
  let parsed:unknown;
  try{parsed=JSON.parse(content);}
  catch{throw new HttpError(502,"The shot planner returned invalid JSON. No cards were changed.");}
  const plan=planSchema.safeParse(parsed);
  if(!plan.success)throw new HttpError(502,"The shot planner returned an invalid shot plan. No cards were changed.");
  if(plan.data.shots.length!==count)throw new HttpError(502,`The shot planner returned ${plan.data.shots.length} shots instead of ${count}. No cards were changed.`);
  return plan.data.shots;
}

/**
 * A premise planner on whichever text provider the workspace chose, named in the answer so the
 * screen can say where the plan came from. It never invents a result when no provider can run.
 */
export async function storyboardPlanRoutes(app:FastifyInstance,pool:Pool){
  app.post("/api/v1/workspaces/:workspaceId/storyboard-plan",async request=>{
    const {workspaceId}=z.object({workspaceId:z.uuid()}).parse(request.params);
    await member(pool,request,workspaceId,"creator");
    const {premise,count}=requestSchema.parse(request.body??{});
    const ask=(note:string)=>generateText("active",{workspaceId,system:`${planSystem(count)}${note}`,prompt:`Premise: ${premise}`,maxTokens:1400,json:true},{pool});
    let answer=await ask("");
    try{return {provider:answer.provider,model:answer.model,shots:parsePlannedShots(extractJsonObject(answer.text),count)};}
    catch{
      // One stricter retry; a second wrong answer is reported, never padded or trimmed.
      answer=await ask(`\nYour previous answer was not a valid list of exactly ${count} shots. Return exactly ${count} entries in the shots array.`);
      return {provider:answer.provider,model:answer.model,shots:parsePlannedShots(extractJsonObject(answer.text),count)};
    }
  });
}
