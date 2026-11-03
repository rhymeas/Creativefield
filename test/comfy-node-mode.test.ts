import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe, expect, it} from 'vitest';

const script = readFileSync('server/comfy-node-mode.js', 'utf8');
const workspace = '12345678-1234-1234-1234-123456789abc';
function editor(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial)), calls: Array<{url: string; method: string; body?: string}> = [];
  const storage = {getItem: (key:string) => stored.get(key) ?? null, setItem: (key:string,value:string) => {stored.set(key,value);}};
  const location = new URL(`http://editor.test/comfy/${workspace}/`);
  const upstream = async (input: string | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req?.url ?? String(input), method = init?.method ?? req?.method ?? 'GET';
    const body = init?.body === undefined ? (req && method === 'POST' ? await req.clone().text() : undefined) : String(init.body);
    calls.push({url,method,body});
    return new Response(JSON.stringify({'Comfy.VueNodes.Enabled':false,'Comfy.Other':7}),{headers:{'content-type':'application/json','etag':'old'}});
  };
  const window = {fetch: upstream,sessionStorage:storage};
  runInNewContext(script,{window,location,URL,Request,Response,Headers});
  return {window,stored,calls,location};
}
describe('node renderer preference in the isolated editor tab',()=>{
  it('applies modern nodes only to successful settings reads and preserves other settings',async()=>{
    const e=editor();const result=await e.window.fetch(`/comfy/${workspace}/api/settings`);
    expect(await result.json()).toEqual({'Comfy.VueNodes.Enabled':true,'Comfy.Other':7});
    expect(result.headers.get('etag')).toBeNull();expect(e.calls).toHaveLength(1);
  });
  it('keeps the classic choice in this tab and never posts that setting upstream',async()=>{
    const e=editor(),path=`/comfy/${workspace}/api/settings/Comfy.VueNodes.Enabled`;
    expect((await e.window.fetch(path,{method:'POST',body:'false'})).ok).toBe(true);
    expect(e.calls).toHaveLength(0);
    expect((await (await e.window.fetch(`/comfy/${workspace}/api/settings`)).json())['Comfy.VueNodes.Enabled']).toBe(false);
    expect((await (await e.window.fetch(path)).json())).toBe(false);
    expect((await (await editor().window.fetch(`/comfy/${workspace}/api/settings`)).json())['Comfy.VueNodes.Enabled']).toBe(true);
  });
  it('forwards other settings and strips the local preference from batch updates',async()=>{
    const e=editor();await e.window.fetch(`/comfy/${workspace}/api/settings`,{method:'POST',body:JSON.stringify({'Comfy.VueNodes.Enabled':false,'Comfy.Other':9})});
    expect(e.calls).toHaveLength(1);expect(JSON.parse(e.calls[0].body!)).toEqual({'Comfy.Other':9});
    await e.window.fetch(`/comfy/${workspace}/api/settings/Comfy.Other`,{method:'POST',body:'8'});
    expect(e.calls).toHaveLength(2);
  });
  it('does not intercept other origins, paths or invalid node-mode values',async()=>{
    const e=editor();await e.window.fetch('https://other.test/api/settings');await e.window.fetch(`/comfy/${workspace}/api/object_info`);
    await e.window.fetch('/comfy/87654321-1234-1234-1234-123456789abc/api/settings');
    expect(e.calls).toHaveLength(3);
    expect((await e.window.fetch(`/comfy/${workspace}/api/settings/Comfy.VueNodes.Enabled`,{method:'POST',body:'"bad"'})).status).toBe(400);
    expect(e.calls).toHaveLength(3);
  });
  it('leaves failed or non-JSON settings reads unchanged',async()=>{
    for (const upstream of [new Response('not ready',{status:503}),new Response('not json',{status:200})]) {
      const location=new URL(`http://editor.test/comfy/${workspace}/`);
      const window={fetch:async (_input:string)=>upstream,sessionStorage:{getItem:()=>null,setItem:()=>{}}};
      runInNewContext(script,{window,location,URL,Request,Response,Headers});
      const result=await window.fetch(`/comfy/${workspace}/api/settings`);
      expect(result.status).toBe(upstream.status);
    }
  });
});
