import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute=promisify(execFile);
export type ToolRunner=(command:string,args:string[])=>Promise<{stdout:string}>;
const runTool:ToolRunner=async(command,args)=>({stdout:String((await execute(command,args,{timeout:5000,maxBuffer:1024*1024,windowsHide:true})).stdout)});
export type ToolIssue={tool:string;reason:"timeout"|"permission"|"failed"|"invalid_response"};
export type FinishingReadiness={state:"ready"|"install_required"|"check_failed";missing:string[];issues:ToolIssue[];instructions:string};
const pending=new WeakMap<ToolRunner,Map<string,Promise<FinishingReadiness>>>();

/** Share only a currently running check, never a stale success or failure.
 * A timeout/failed launch does not prove an executable is absent. */
export function finishingReadiness(encoders=false,run:ToolRunner=runTool):Promise<FinishingReadiness>{
  const ffmpeg=process.env.FFMPEG_PATH??"ffmpeg",ffprobe=process.env.FFPROBE_PATH??"ffprobe";
  const key=JSON.stringify([encoders,ffmpeg,ffprobe,process.cwd(),process.env.PATH]);
  let checks=pending.get(run);if(!checks){checks=new Map();pending.set(run,checks);}
  const existing=checks.get(key);if(existing)return existing;
  const encoderStatus=(stdout:string)=>{
    if(!/^\s*Encoders:/m.test(stdout))return "invalid_response";
    return /\blibx264\b/.test(stdout)&&/\baac\b/.test(stdout)?"ready":"missing";
  };
  const check=async(tool:string,command:string,args:string[],missingLabel:string,validate:(stdout:string)=>"ready"|"missing"|"invalid_response")=>{
    try{const status=validate((await run(command,args)).stdout);return {missing:status==="missing"?missingLabel:undefined,issue:status==="invalid_response"?{tool,reason:"invalid_response" as const}:undefined};}
    catch(error){
      const e=error as {code?:unknown;killed?:boolean};
      if(e?.code==="ENOENT")return {missing:missingLabel};
      const reason:ToolIssue["reason"]=e?.killed||e?.code==="ETIMEDOUT"?"timeout":e?.code==="EACCES"||e?.code==="EPERM"?"permission":"failed";
      return {issue:{tool,reason}};
    }
  };
  const operation=(async()=>{
    const results=await Promise.all([
      check("FFmpeg",ffmpeg,encoders?["-hide_banner","-encoders"]:["-version"],encoders?"FFmpeg with libx264 and AAC encoders":"FFmpeg",stdout=>encoders?encoderStatus(stdout):/^ffmpeg version\b/im.test(stdout)?"ready":"invalid_response"),
      check("FFprobe",ffprobe,["-version"],"FFprobe",stdout=>/^ffprobe version\b/im.test(stdout)?"ready":"invalid_response"),
    ]);
    const missing=results.flatMap(result=>result.missing?[result.missing]:[]),issues=results.flatMap(result=>result.issue?[result.issue]:[]);
    const issueHint=issues.some(issue=>issue.reason==="timeout")?"Media tools did not answer in time. Retry the check; if it repeats, inspect the server executable settings.":issues.some(issue=>issue.reason==="permission")?"Media tools could not run. Check their executable permissions and retry.":"Media tools could not be checked. Verify the server executable settings and retry.";
    return {state:missing.length?"install_required":issues.length?"check_failed":"ready",missing,issues,instructions:missing.length?`Install FFmpeg and FFprobe on the team server, or set FFMPEG_PATH and FFPROBE_PATH to their executables.${issues.length?` ${issueHint}`:""}`:issues.length?issueHint:""} satisfies FinishingReadiness;
  })();
  checks.set(key,operation);
  void operation.finally(()=>{if(checks.get(key)===operation)checks.delete(key);});
  return operation;
}
