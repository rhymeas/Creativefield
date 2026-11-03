import {describe,it,expect,vi} from "vitest";
import {EventEmitter} from "node:events";
import {Readable,PassThrough} from "node:stream";
import type {IncomingMessage,ClientRequest} from "node:http";
import type {RequestOptions} from "node:https";
import {approvedOrigin,bindingHash,DirectRegistry,productionDirectRegistry} from "../server/providers/registry";
import {createProviderTransport,publicIPv4,type TransportDependencies} from "../server/providers/transport";
import type {DirectBinding,DirectAdapter} from "../server/providers/types";
import {plannedCapabilities} from "../src/capabilities/catalogue";
import {capabilityReadiness} from "../src/capabilities/readiness";

const binding:DirectBinding={capabilityId:"fixture-video",capabilityVersion:"1.0.0",routeId:"direct",adapterId:"fixture-wan",adapterVersion:"1",provider:"wan",model:"fixture-model",upstreamProviders:[],apiOrigins:["https://api.example.com"],artifactOrigins:["https://media.example.com"]};
const adapter:DirectAdapter={id:"fixture-wan",version:"1",provider:"wan",recovery:"unsupported",cancellation:"unsupported",validate:()=>({valid:true}),estimate:async()=>({kind:"unknown"}),prepareInputs:async()=>({}),submit:async()=>({kind:"unknown"}),poll:async()=>({state:"pending"}),cancel:async()=>({kind:"unsupported"}),recover:async()=>({kind:"unsupported"}),outputs:async()=>[]};
function manifest(){return {...structuredClone(plannedCapabilities[0]),id:binding.capabilityId,version:binding.capabilityVersion,routes:[{id:"direct",provider:"wan",upstreamProviders:[],execution:"direct_provider" as const,implementation:"implemented" as const,requirements:[],evidence:[]}]};}
function fixture(options:{status?:number;chunks?:string[];headers?:Record<string,string>;addresses?:string[];hang?:boolean}={}){
  const calls:Array<{url:URL;options:RequestOptions;body:unknown;destroyed:boolean}>=[];
  const resolve=vi.fn(async()=>options.addresses??["93.184.216.34"]);
  const request:TransportDependencies["request"]=(url,requestOptions,callback)=>{
    const call={url,options:requestOptions,body:undefined as unknown,destroyed:false};calls.push(call);
    const req=Object.assign(new EventEmitter(),{end:(body:unknown)=>{call.body=body;if(!options.hang)queueMicrotask(()=>{
      const response=Readable.from(options.chunks??['{"accepted":true}']) as IncomingMessage;
      response.statusCode=options.status??200;response.headers={"content-type":"application/json",...options.headers};callback(response);
    });},destroy:()=>{call.destroyed=true;return req;}});
    return req as unknown as ClientRequest;
  };
  const dependencies:TransportDependencies={resolve,request};
  return {calls,resolve,dependencies};
}
async function consume(body:Readable){const chunks:Buffer[]=[];for await(const part of body)chunks.push(Buffer.from(part));return Buffer.concat(chunks).toString();}

describe("independent direct registry",()=>{
  it("keeps unregistered direct routes unavailable even with matching inventory",()=>{
    expect(productionDirectRegistry.resolve(manifest(),"direct")).toBeNull();
    expect(capabilityReadiness(manifest(),"direct",{online:true,nodes:[],models:[],credentials:["wan"]}).state).toBe("unsupported");
    const partner=manifest();partner.routes[0].execution="comfy_partner" as "direct_provider";
    expect(capabilityReadiness(partner,"direct",{online:true,nodes:[],models:[],credentials:["wan"]}).state).toBe("unsupported");
  });
  it("pins an immutable exact binding and method references",()=>{
    const input=structuredClone(binding),impl={...adapter},r=new DirectRegistry([{binding:input,adapter:impl,qualified:true}]),resolved=r.resolve(manifest(),"direct")!;
    (input.apiOrigins as string[])[0]="https://changed.example.com";impl.validate=()=>({valid:false,code:"rejected"});
    expect(resolved.binding.apiOrigins).toEqual(binding.apiOrigins);expect(Object.isFrozen(resolved.binding.apiOrigins)).toBe(true);
    expect(resolved.adapter.validate({} as never)).toEqual({valid:true});expect(resolved.hash).toBe(bindingHash(binding));
  });
  it("rejects duplicate, unqualified and wrong adapter registrations",()=>{
    const registration={binding,adapter,qualified:true};expect(()=>new DirectRegistry([registration,registration])).toThrow("Duplicate");
    expect(()=>new DirectRegistry([{...registration,qualified:false}])).toThrow("qualified");
    expect(()=>new DirectRegistry([{...registration,adapter:{...adapter,version:"2"}}])).toThrow("qualified");
  });
  it("never resolves mismatched versions, routes, providers, origins or planned routes",()=>{
    const registry=new DirectRegistry([{binding,adapter,qualified:true}]);
    for(const change of [{version:"2"},{id:"unknown"}])expect(registry.resolve({...manifest(),...change},"direct")).toBeNull();
    expect(registry.resolve(manifest(),"local")).toBeNull();
    for(const change of [{provider:"kling"},{implementation:"planned" as const},{implementation:"experimental" as const},{endpointOrigin:"https://other.example.com"},{upstreamProviders:["minimax"]}]){
      const m=manifest();Object.assign(m.routes[0],change);expect(registry.resolve(m,"direct")).toBeNull();
    }
  });
  it("excludes forbidden providers, wrappers and execution endpoints",()=>{
    for(const provider of ["higgsfield","genjutsu","pryx","comfy-local","comfy-partner","unknown"])
      expect(()=>new DirectRegistry([{binding:{...binding,provider},adapter:{...adapter,provider},qualified:true}])).toThrow();
    expect(()=>new DirectRegistry([{binding:{...binding,upstreamProviders:["higgsfield"]},adapter,qualified:true}])).toThrow();
    expect(()=>approvedOrigin("https://api.higgsfield.ai")).toThrow();
  });
  it("restricts origins to domain names on HTTPS default port",()=>{
    for(const value of ["http://api.example.com","https://api.example.com:8443","https://user:secret@api.example.com","https://api.example.com/path","https://api.example.com?q=x","https://api.example.com#x","https://127.0.0.1","https://[::1]","https://api.example.com.","https://localhost","https://bad_name.example.com"])
      expect(()=>approvedOrigin(value),value).toThrow();
    expect(approvedOrigin("https://API.example.com:443/")).toBe("https://api.example.com");
  });
});
describe("bounded provider transport (injected fixtures; no external requests)",()=>{
  it("denies private, reserved, malformed and IPv6 addresses",()=>{
    for(const ip of ["0.1.2.3","10.1.2.3","100.64.0.1","100.127.255.255","127.0.0.1","169.254.169.254","172.16.0.1","172.31.255.255","192.168.1.1","192.0.0.9","192.0.2.1","192.88.99.2","198.18.1.1","198.51.100.1","203.0.113.1","224.0.0.1","240.0.0.1","255.255.255.255","::1","::ffff:8.8.8.8","0300.0250.1.1","bad"])expect(publicIPv4(ip),ip).toBe(false);
    for(const ip of ["93.184.216.34","8.8.8.8","172.15.255.255","172.32.0.1","100.128.0.1"])expect(publicIPv4(ip),ip).toBe(true);
  });
  it("pins DNS to the checked address while retaining hostname TLS validation",async()=>{
    const f=fixture(),transport=createProviderTransport(binding,"Bearer fixture-secret",{},f.dependencies);
    expect(await transport.api("/jobs",{method:"POST",body:{prompt:"cup"}})).toEqual({accepted:true});
    const options=f.calls[0].options;
    expect(options).toMatchObject({agent:false,rejectUnauthorized:true,servername:"api.example.com",family:4,autoSelectFamily:false});
    const lookup=options.lookup as (name:string,opts:object,cb:(err:unknown,address:string,family:number)=>void)=>void;
    const cb=vi.fn();lookup("api.example.com",{},cb);expect(cb).toHaveBeenCalledWith(null,"93.184.216.34",4);
    expect(f.resolve).toHaveBeenCalledTimes(1);expect(options.headers).toHaveProperty("Authorization","Bearer fixture-secret");expect(f.calls[0].body?.toString()).toBe('{"prompt":"cup"}');
  });
  it.each([[],["127.0.0.1"],["93.184.216.34","10.0.0.1"],["::1"]])("denies entire DNS result before connecting: %j",async(...addresses)=>{
    const f=fixture({addresses:addresses as string[]}),t=createProviderTransport(binding,undefined,{},f.dependencies);
    await expect(t.api("/jobs")).rejects.toMatchObject({code:"destination_denied"});expect(f.calls).toHaveLength(0);
  });
  it("does not forward API authorization to signed artifact requests",async()=>{
    const f=fixture({chunks:["video-data"],headers:{"content-type":"video/mp4"}}),t=createProviderTransport(binding,"Bearer fixture-secret",{},f.dependencies);
    const result=await t.artifact("https://media.example.com/output.mp4?signature=private-token",1024);
    expect(await consume(result.body)).toBe("video-data");expect(result.contentType).toBe("video/mp4");expect(f.calls[0].options.headers).not.toHaveProperty("Authorization");
    expect(f.calls[0].options.method).toBe("GET");
  });
  it("rejects endpoint overrides, absolute paths and foreign artifact hosts before DNS",async()=>{
    const f=fixture(),t=createProviderTransport(binding,"secret",{},f.dependencies);
    for(const path of ["https://other.example.com/jobs","//other.example.com/jobs","/\\other.example.com","/jobs#secret"])
      await expect(t.api(path)).rejects.toMatchObject({code:"invalid_request"});
    await expect(t.api("/jobs",{origin:"https://other.example.com"})).rejects.toMatchObject({code:"destination_denied"});
    for(const url of ["https://api.example.com/video","https://other.example.com/video","https://user:secret@media.example.com/video","https://media.example.com/video#secret"])
      await expect(t.artifact(url,1024)).rejects.toMatchObject({code:"destination_denied"});
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it.each([301,302,307,308])("does not follow redirect %d or retry the mutation",async status=>{
    const f=fixture({status,headers:{location:"https://evil.example/token-secret"}}),t=createProviderTransport(binding,"secret",{},f.dependencies);
    await expect(t.api("/jobs",{method:"POST"})).rejects.toMatchObject({code:"redirect_denied"});expect(f.calls).toHaveLength(1);expect(f.calls[0].destroyed).toBe(true);
  });
  it("bounds declared and actual bytes and outgoing JSON",async()=>{
    const large=fixture({headers:{"content-length":"100"}}),t=createProviderTransport(binding,undefined,{jsonBytes:10},large.dependencies);
    await expect(t.api("/jobs")).rejects.toMatchObject({code:"too_large"});
    const chunks=fixture({chunks:["012345","678901"]}),t2=createProviderTransport(binding,undefined,{jsonBytes:10},chunks.dependencies);
    await expect(t2.api("/jobs")).rejects.toMatchObject({code:"too_large"});
    await expect(t2.api("/jobs",{method:"POST",body:{too:"long-string"}})).rejects.toMatchObject({code:"too_large"});expect(chunks.calls).toHaveLength(1);
    const file=fixture({chunks:["abcdef"]}),t3=createProviderTransport(binding,undefined,{},file.dependencies);
    await expect(consume((await t3.artifact("https://media.example.com/video",4)).body)).rejects.toMatchObject({code:"too_large"});
  });
  it("bounds DNS resolution, headers and unconsumed artifact body time",async()=>{
    const f=fixture({hang:true}),t=createProviderTransport(binding,undefined,{timeoutMs:15},f.dependencies);
    await expect(t.api("/jobs",{method:"POST"})).rejects.toMatchObject({code:"timeout"});expect(f.calls).toHaveLength(1);
    const stalled=fixture();stalled.dependencies.resolve=()=>new Promise(()=>{});
    await expect(createProviderTransport(binding,undefined,{timeoutMs:15},stalled.dependencies).api("/jobs")).rejects.toMatchObject({code:"timeout"});expect(stalled.calls).toHaveLength(0);
    const bodyFixture=fixture();bodyFixture.dependencies.request=(_url,_opts,callback)=>{
      const req=Object.assign(new EventEmitter(),{end:()=>{const response=new PassThrough() as unknown as IncomingMessage;response.statusCode=200;response.headers={"content-type":"video/mp4"};queueMicrotask(()=>callback(response));},destroy:()=>req});return req as unknown as ClientRequest;
    };
    const output=await createProviderTransport(binding,undefined,{timeoutMs:15},bodyFixture.dependencies).artifact("https://media.example.com/video",100);
    await expect(consume(output.body)).rejects.toMatchObject({code:"timeout"});
  });
  it("sanitizes HTTP, parse, transport and signed URL failures",async()=>{
    for(const options of [{status:401,chunks:["fixture-secret"]},{chunks:["fixture-secret"]},{headers:{"content-encoding":"gzip"}}]){
      const f=fixture(options),t=createProviderTransport(binding,"fixture-secret",{},f.dependencies);
      try{await t.api("/jobs?signature=private-token");throw new Error("expected rejection");}catch(e){expect(String(e)).not.toMatch(/fixture-secret|private-token|example.com/);expect(e).toHaveProperty("code");}
    }
    const f=fixture();f.dependencies.resolve=async()=>{throw new Error("secret-dns-payload");};
    await expect(createProviderTransport(binding,undefined,{},f.dependencies).api("/jobs")).rejects.toThrow("Provider transport: network");
  });
  it("rejects invalid limits and header injection",()=>{
    for(const timeoutMs of [0,NaN,120001])expect(()=>createProviderTransport(binding,undefined,{timeoutMs})).toThrow();
    expect(()=>createProviderTransport(binding,"secret\r\nInjected: yes")).toThrow("invalid_request");
    expect(()=>createProviderTransport(binding,undefined,{jsonBytes:0})).toThrow();
  });
});
