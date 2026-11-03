import {describe,it,expect,vi} from "vitest";
import {finishingReadiness,type ToolRunner} from "../server/finishing-readiness";

const encoders="Encoders:\n V....D libx264 H.264\n A..... aac AAC";
const stdout=(command:string,args:string[])=>args.includes("-encoders")?encoders:command===(process.env.FFPROBE_PATH??"ffprobe")?"ffprobe version fixture":"ffmpeg version fixture";
const failure=(code:string,killed=false)=>Object.assign(Error("private/executable/location"),{code,killed});

describe("finishing tool readiness",()=>{
  it("requires a real encoder listing and both version/encoder checks before ready",async()=>{
    const run=vi.fn(async(command:string,args:string[])=>({stdout:stdout(command,args)}));
    expect(await finishingReadiness(true,run)).toMatchObject({state:"ready",missing:[],issues:[],instructions:""});
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(process.env.FFMPEG_PATH??"ffmpeg",["-hide_banner","-encoders"]);
  });
  it.each([["ETIMEDOUT",true,"timeout"],["EACCES",false,"permission"],["EPERM",false,"permission"],["EAGAIN",false,"failed"]] as const)("does not classify %s as an absent executable",async(code,killed,reason)=>{
    const run:ToolRunner=async(command,args)=>{if(command===(process.env.FFPROBE_PATH??"ffprobe"))throw failure(code,killed);return {stdout:stdout(command,args)};};
    const result=await finishingReadiness(true,run);
    expect(result.state).toBe("check_failed");expect(result.missing).toEqual([]);expect(result.issues).toEqual([{tool:"FFprobe",reason}]);
    expect(result.instructions).not.toMatch(/install/i);expect(JSON.stringify(result)).not.toContain("private/executable/location");
  });
  it("keeps genuine missing commands and unsupported encoder builds as installation requirements",async()=>{
    const missing:ToolRunner=async(command,args)=>{if(args.includes("-encoders"))throw failure("ENOENT");return {stdout:stdout(command,args)};};
    expect(await finishingReadiness(true,missing)).toMatchObject({state:"install_required",missing:["FFmpeg with libx264 and AAC encoders"],issues:[]});
    const noAac:ToolRunner=async(command,args)=>({stdout:args.includes("-encoders")?"Encoders:\n V....D libx264 H.264":stdout(command,args)});
    expect((await finishingReadiness(true,noAac)).state).toBe("install_required");
  });
  it("rejects empty or unrelated successful command output without an install diagnosis",async()=>{
    const result=await finishingReadiness(true,async()=>({stdout:"unrelated output"}));
    expect(result.state).toBe("check_failed");expect(result.missing).toEqual([]);expect(result.issues.map(issue=>issue.reason)).toEqual(["invalid_response","invalid_response"]);
  });
  it("shares an in-flight check, then probes afresh after it completes",async()=>{
    const releases:Array<()=>void>=[];
    const run=vi.fn((command:string,args:string[])=>new Promise<{stdout:string}>(resolve=>releases.push(()=>resolve({stdout:stdout(command,args)}))));
    const first=finishingReadiness(true,run),second=finishingReadiness(true,run);
    expect(second).toBe(first);expect(run).toHaveBeenCalledTimes(2);
    releases.forEach(release=>release());expect((await first).state).toBe("ready");await second;
    run.mockImplementation(async(command,args)=>({stdout:stdout(command,args)}));
    await finishingReadiness(true,run);expect(run).toHaveBeenCalledTimes(4);
  });
  it("does not reuse a check when an executable setting changes",async()=>{
    const original=process.env.FFPROBE_PATH;
    const run=vi.fn(async(_command:string,args:string[])=>({stdout:args.includes("-encoders")?encoders:"ffprobe version fixture"}));
    try{const first=finishingReadiness(true,run);process.env.FFPROBE_PATH="another-ffprobe";const second=finishingReadiness(true,run);expect(second).not.toBe(first);await Promise.all([first,second]);expect(run).toHaveBeenCalledTimes(4);}
    finally{if(original===undefined)delete process.env.FFPROBE_PATH;else process.env.FFPROBE_PATH=original;}
  });
});
