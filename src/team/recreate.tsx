import {createContext,useContext,type ReactNode} from "react";
import {workspacePath,type Asset,type Call,type Run} from "./api";

/** Gives a finished run the way back into the tool it was made in, or nothing where that cannot work.
 *  The app provides it once; every list of runs asks it, so no screen decides on its own. */
export type RecreateRun=(run:Run)=>(()=>void)|undefined;
const RecreateContext=createContext<RecreateRun>(()=>undefined);
export function RecreateProvider({value,children}:{value:RecreateRun;children:ReactNode}){return <RecreateContext.Provider value={value}>{children}</RecreateContext.Provider>;}
export const useRecreate=()=>useContext(RecreateContext);

/** Recreate for media that is not a run here (the bundled examples): the tool, the files for its ports and its settings.
 *  The app uploads the files into the project and opens the tool filled in; nothing where that tool cannot open. */
export type RecreateSetup={capabilityId:string;inputs:Record<string,{src:string;name:string}>;controls?:Record<string,string|number|boolean>}
  /** An example with no recorded setup: a picture opens the image edit tool with it, a clip opens Restyle with it. */
  |{example:{src:string;name:string;kind:"image"|"video"}};
export type RecreateMedia=(setup:RecreateSetup)=>(()=>Promise<void>)|undefined;
const RecreateMediaContext=createContext<RecreateMedia>(()=>undefined);
export function RecreateMediaProvider({value,children}:{value:RecreateMedia;children:ReactNode}){return <RecreateMediaContext.Provider value={value}>{children}</RecreateMediaContext.Provider>;}
export const useRecreateMedia=()=>useContext(RecreateMediaContext);

/** The run that made a stored file: recorded on the file, else found among the project's runs. */
export function producerRunId(asset:Pick<Asset,"id"|"metadata">,runs:Pick<Run,"id"|"output_ids">[]=[]):string|undefined{
  const generated=asset.metadata?.generatedBy as {producerRunId?:unknown;runId?:unknown}|undefined;
  const recorded=generated?.producerRunId??generated?.runId;
  return typeof recorded==="string"?recorded:runs.find(run=>run.output_ids.includes(asset.id))?.id;
}
/** Recreate for a file or tile that holds only a run id: reads the run's inputs and settings, then opens its tool. */
export function useRecreateById(call:Call,workspaceId:string,onError:(message:string)=>void){
  const recreate=useRecreate();
  return async(runId:string)=>{
    try{const run=await call<Run>(workspacePath(workspaceId,`runs/${encodeURIComponent(runId)}`));const go=recreate(run);if(go)go();else onError("This result cannot be opened again in its tool.");}
    catch(error){onError((error as Error).message);}
  };
}
