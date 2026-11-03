import {describe,it,expect} from 'vitest';
import {join} from 'node:path';
import {resolveProbeRuntime,requireImageRuntime,probeServerArgs,type RuntimeDeps} from '../scripts/codex-probe-runtime';

const env={LOCALAPPDATA:(process.cwd() + "/public-fixtures/fixture/local"),APPDATA:(process.cwd() + "/public-fixtures/fixture/roaming")};
function fixture(versions:Record<string,string>,dirs=['old','new']){
 const calls:{bin:string;args:string[]}[]=[];
 const deps:RuntimeDeps={exists:async()=>true,directories:async()=>dirs,run:async(bin,args)=>{calls.push({bin,args});return args.includes('--version')?versions[bin]??'codex-cli 0.115.0':'image_generation stable true\nshell_tool stable true';}};
 return {deps,calls};
}
describe('native subscription probe runtime selection (no real processes)',()=>{
 it('prefers the newer installed desktop runtime over npm without hardcoding its directory hash',async()=>{
  const old=join(env.LOCALAPPDATA,'OpenAI/Codex/bin/old/codex.exe'),latest=join(env.LOCALAPPDATA,'OpenAI/Codex/bin/new/codex.exe');
  const f=fixture({[old]:'codex-cli 0.115.0',[latest]:'codex-cli 0.164.0-alpha.11.1'});
  const runtime=await resolveProbeRuntime(env,'win32',f.deps);expect(runtime).toMatchObject({bin:latest,source:'desktop',version:'codex-cli 0.164.0-alpha.11.1',imageGeneration:true});expect(()=>requireImageRuntime(runtime)).not.toThrow();expect(f.calls.some(c=>c.args.some(a=>a.includes('npm')))).toBe(false);
 });
 it('honors an explicit executable and inspects only that binary',async()=>{
  const f=fixture({[(process.cwd() + "/public-fixtures/fixture/codex.exe")]:'codex-cli 0.165.0'});const r=await resolveProbeRuntime({...env,COMFYFIELD_CODEX_BIN:(process.cwd() + "/public-fixtures/fixture/codex.exe")},'win32',f.deps);expect(r.source).toBe('explicit');expect(f.calls.every(c=>c.bin===(process.cwd() + "/public-fixtures/fixture/codex.exe"))).toBe(true);
 });
 it('orders same-version prereleases numerically and prefers a stable release',async()=>{
  const base=join(env.LOCALAPPDATA,'OpenAI/Codex/bin'),a=join(base,'a/codex.exe'),b=join(base,'b/codex.exe');
  const f=fixture({[a]:'codex-cli 0.164.0-alpha.9',[b]:'codex-cli 0.164.0-alpha.11'},['a','b']);expect((await resolveProbeRuntime(env,'win32',f.deps)).bin).toBe(b);
  const stable=fixture({[a]:'codex-cli 0.164.0',[b]:'codex-cli 0.164.0-alpha.11'},['a','b']);expect((await resolveProbeRuntime(env,'win32',stable.deps)).bin).toBe(a);
 });
 it('does not fall back after an explicit runtime fails or its path is invalid',async()=>{
  const f=fixture({});f.deps.run=async()=>{throw new Error('launch failed');};await expect(resolveProbeRuntime({...env,COMFYFIELD_CODEX_BIN:(process.cwd() + "/public-fixtures/aa38933c/sample")},'win32',f.deps)).rejects.toThrow('launch failed');await expect(resolveProbeRuntime({...env,COMFYFIELD_CODEX_BIN:'relative.exe'},'win32',f.deps)).rejects.toThrow('absolute');
 });
 it('identifies the npm fallback but refuses its old image protocol before a model turn',async()=>{
  const f=fixture({},[]);const runtime=await resolveProbeRuntime(env,'win32',f.deps);expect(runtime.source).toBe('npm');expect(runtime.prefix[0]).toContain('codex.js');expect(()=>requireImageRuntime(runtime)).toThrow('predates');expect(()=>requireImageRuntime({...runtime,version:'codex-cli 0.164.0',imageGeneration:false})).toThrow('not enabled');
 });
 it('does not rewrite the configured model or service tier in launcher overrides',()=>{
  const args=probeServerArgs(['-c','mcp_servers.pad.enabled=false']);expect(args).toContain('features.multi_agent=false');expect(args).toContain('features.shell_tool=false');expect(args).toContain('model_reasoning_effort="low"');expect(args).not.toContain('service_tier="flex"');expect(args.some(a=>/^model=|^service_tier=/.test(a))).toBe(false);
 });
});
