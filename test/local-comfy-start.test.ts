import {EventEmitter} from "node:events";
import path from "node:path";
import {describe,expect,it,vi} from "vitest";
import {createLocalComfyStarter,managedLocalComfyOrigin} from "../server/local-comfy-start";

describe("managed local ComfyUI startup",()=>{
  it("accepts only the bundled loopback worker address",()=>{
    expect(managedLocalComfyOrigin("http://127.0.0.1:8188")).toBe(true);
    expect(managedLocalComfyOrigin("http://localhost:8188")).toBe(true);
    expect(managedLocalComfyOrigin("https://127.0.0.1:8188")).toBe(false);
    expect(managedLocalComfyOrigin("http://127.0.0.1:8190")).toBe(false);
    expect(managedLocalComfyOrigin("http://example.test:8188")).toBe(false);
  });
  it("allows one explicitly configured loopback worker instead of the default",()=>{
    const env={COMFYFIELD_COMFY_ORIGIN:'http://127.0.0.1:8288'};
    expect(managedLocalComfyOrigin('http://localhost:8288',env)).toBe(true);
    expect(managedLocalComfyOrigin('http://127.0.0.1:8188',env)).toBe(false);
    expect(managedLocalComfyOrigin('http://remote.test:8288',env)).toBe(false);
    expect(managedLocalComfyOrigin('http://127.0.0.1:8288/path',env)).toBe(false);
  });

  it("launches the fixed hidden script and coalesces repeat clicks",async()=>{
    const child=Object.assign(new EventEmitter(),{unref:vi.fn()});
    const launch=vi.fn((_command:string,_args:string[],_options:unknown)=>{queueMicrotask(()=>child.emit("spawn"));return child as any;});
    const starter=createLocalComfyStarter({root:process.cwd(),platform:"win32",now:()=>10_000,launch});
    await expect(starter("http://127.0.0.1:8188")).resolves.toEqual({state:"launch_requested"});
    await expect(starter("http://127.0.0.1:8188")).resolves.toEqual({state:"already_starting"});
    expect(launch).toHaveBeenCalledOnce();
    const script=path.resolve(process.cwd(),"scripts","start-comfy.bat");
    expect(launch.mock.calls[0][1]).toEqual(["/d","/s","/c",script.includes(" ")?`"${script}"`:script]);
    expect(launch.mock.calls[0][2]).toMatchObject({detached:true,stdio:"ignore",windowsHide:true});
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it("starts the configured local worker and refuses shell metacharacters",async()=>{
    const child=Object.assign(new EventEmitter(),{unref:vi.fn()});
    const launch=vi.fn((_command:string,_args:string[],_options:unknown)=>{queueMicrotask(()=>child.emit('spawn'));return child as any;});
    const script=path.resolve(process.cwd(),'scripts','start-comfy.bat');
    const env={COMFYFIELD_COMFY_ORIGIN:'http://127.0.0.1:8288',COMFYFIELD_COMFY_START_SCRIPT:script};
    const starter=createLocalComfyStarter({platform:'win32',env,launch});
    await expect(starter('http://127.0.0.1:8288')).resolves.toEqual({state:'launch_requested'});
    expect(launch.mock.calls[0][1]).toContain(script.includes(' ')?`"${script}"`:script);
    const unsafe=createLocalComfyStarter({platform:'win32',env:{...env,COMFYFIELD_COMFY_START_SCRIPT:path.join(process.cwd(),'bad&command.cmd')},launch});
    await expect(unsafe('http://127.0.0.1:8288')).rejects.toThrow('Invalid local ComfyUI startup script path');
  });
});
