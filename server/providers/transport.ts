import {resolve4} from "node:dns/promises";
import {request as httpsRequest,type RequestOptions} from "node:https";
import type {ClientRequest,IncomingMessage} from "node:http";
import {Readable} from "node:stream";
import {isIPv4} from "node:net";
import type {EventEmitter} from "node:events";
import {approvedOrigin,freezeBinding} from "./registry";
import type {AdapterTransport,DirectBinding} from "./types";
import {uploadRouterInput} from './router-upload';

export type TransportErrorCode="invalid_request"|"destination_denied"|"timeout"|"network"|"redirect_denied"|"http_error"|"too_large"|"invalid_response";
export class ProviderTransportError extends Error {
  constructor(readonly code:TransportErrorCode,readonly status?:number){super(`Provider transport: ${code}`);this.name="ProviderTransportError";}
}
const fault=(code:TransportErrorCode)=>new ProviderTransportError(code);
/** Conservatively excludes special-use ranges, including some globally routed exceptions. */
export function publicIPv4(value:string):boolean {
  if(!isIPv4(value))return false;
  const [a,b,c]=value.split(".").map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&((b===0&&(c===0||c===2))||(b===88&&c===99)||b===168||(b===31&&c===196)||(b===52&&c===193)||(b===175&&c===48)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
export type TransportDependencies={resolve:(hostname:string)=>Promise<string[]>;request:(url:URL,options:RequestOptions,callback:(response:IncomingMessage)=>void)=>ClientRequest};
const productionDependencies:TransportDependencies={resolve:hostname=>resolve4(hostname),request:(url,options,callback)=>httpsRequest(url,options,callback)};
type Limits={timeoutMs?:number;jsonBytes?:number};
const bounded=(v:number,min:number,max:number)=>Number.isSafeInteger(v)&&v>=min&&v<=max;

/** Server-only. Injected dependencies are for tests, never from request/config data. */
export function createProviderTransport(source:DirectBinding,authorization:string|undefined,limits:Limits={},dependencies:TransportDependencies=productionDependencies):AdapterTransport {
  const binding=freezeBinding(source),timeoutMs=limits.timeoutMs??20000,jsonBytes=limits.jsonBytes??(binding.provider==='comfy-router'?16*1024*1024:1024*1024);
  if(!bounded(timeoutMs,1,120000)||!bounded(jsonBytes,1,16*1024*1024)||(authorization!==undefined&&(!authorization||authorization.length>16384||/[\r\n\x00]/.test(authorization))))throw fault("invalid_request");
  async function open(url:URL,method:string,body:Buffer|undefined,maxBytes:number,api:boolean,idempotencyKey?:string):Promise<{body:Readable;contentType:string}>{
    if(!bounded(maxBytes,1,2*1024*1024*1024))throw fault("invalid_request");
    return new Promise((resolve,reject)=>{
      let request:ClientRequest|undefined,response:IncomingMessage|undefined,stream:Readable|undefined,settled=false;
      const timer=setTimeout(()=>fail(fault("timeout")),timeoutMs);
      const finish=()=>clearTimeout(timer);
      const fail=(error:ProviderTransportError)=>{
        finish();request?.destroy();response?.destroy();stream?.destroy(error);
        if(!settled){settled=true;reject(error);}
      };
      void (async()=>{
        const addresses=await dependencies.resolve(url.hostname);
        if(settled)return;
        if(!addresses.length||addresses.some(a=>!publicIPv4(a)))throw fault("destination_denied");
        const address=addresses[0];
        const options:RequestOptions&{autoSelectFamily:false}={method,agent:false,family:4,autoSelectFamily:false,rejectUnauthorized:true,servername:url.hostname,
          lookup:(_hostname,_options,callback)=>callback(null,address,4),
          headers:{Accept:api?"application/json":"*/*","Accept-Encoding":"identity",...(api&&authorization?{Authorization:authorization}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{}),...(body?{"Content-Type":"application/json","Content-Length":String(body.length)}:{})}};
        request=dependencies.request(url,options,incoming=>{
          response=incoming;
          // busboy augments Readable.on with a narrow 'limit' overload in this project.
          (response as EventEmitter).on("error",()=>fail(fault("network")));
          if(settled){response.destroy();return;}
          const status=response.statusCode??0;
          if(status>=300&&status<400){fail(fault("redirect_denied"));return;}
          if(status<200||status>=300){fail(new ProviderTransportError('http_error',status));return;}
          const length=response.headers["content-length"];
          if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>maxBytes)){fail(fault("too_large"));return;}
          const encoding=response.headers["content-encoding"];
          if(encoding&&encoding!=="identity"){fail(fault("invalid_response"));return;}
          const contentType=String(response.headers["content-type"]??"application/octet-stream").split(";")[0].trim().toLowerCase();
          const input=response;
          stream=Readable.from((async function*(){
            let total=0;
            try {for await(const chunk of input){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=data.length;if(total>maxBytes)throw fault("too_large");yield data;}}
            catch(e){throw e instanceof ProviderTransportError?e:fault("network");}
            finally{finish();input.destroy();request?.destroy();}
          })(),{objectMode:false});
          // Avoid an unhandled error when a deadline expires before the consumer starts.
          (stream as EventEmitter).on("error",()=>{});(stream as EventEmitter).once("close",()=>{finish();input.destroy();request?.destroy();});
          settled=true;resolve({body:stream,contentType});
        });
        request.on("error",()=>fail(fault("network")));
        request.end(body);
      })().catch(e=>fail(e instanceof ProviderTransportError?e:fault("network")));
    });
  }
  function checkedUrl(value:string,origins:readonly string[]):URL {
    let url:URL;try{url=new URL(value);}catch{throw fault("destination_denied");}
    if(url.username||url.password||url.hash||!origins.includes(url.origin))throw fault("destination_denied");
    try{if(approvedOrigin(url.origin)!==url.origin)throw fault("destination_denied");}catch{throw fault("destination_denied");}
    return url;
  }
  return Object.freeze({
    async api(path:string,options:{method?:"GET"|"POST"|"PUT"|"DELETE";body?:unknown;origin?:string;idempotencyKey?:string}={}){
      if(!path.startsWith("/")||path.startsWith("//")||/[\\\r\n\x00#]/.test(path))throw fault("invalid_request");
      const origin=options.origin??binding.apiOrigins[0];
      if(!binding.apiOrigins.includes(origin))throw fault("destination_denied");
      const url=checkedUrl(new URL(path,origin).href,binding.apiOrigins),method=options.method??"GET";
      if(!["GET","POST","PUT","DELETE"].includes(method)||(method==="GET"&&options.body!==undefined)||options.idempotencyKey!==undefined&&!/^[a-zA-Z0-9_.-]{1,128}$/.test(options.idempotencyKey))throw fault("invalid_request");
      let data:Buffer|undefined;
      if(options.body!==undefined){try{data=Buffer.from(JSON.stringify(options.body));}catch{throw fault("invalid_request");}if(data.length>jsonBytes)throw fault("too_large");}
      const result=await open(url,method,data,jsonBytes,true,options.idempotencyKey),parts:Buffer[]=[];
      for await(const chunk of result.body)parts.push(chunk as Buffer);
      if(result.contentType!=="application/json"&&!result.contentType.endsWith("+json"))throw fault("invalid_response");
      try{return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;}catch{throw fault("invalid_response");}
    },
    async artifact(value:string,maxBytes:number){return open(checkedUrl(value,binding.artifactOrigins),"GET",undefined,maxBytes,false);},
    ...(binding.provider==='comfy-router'&&authorization?{upload:(input:import('./types').OwnedInput)=>uploadRouterInput(input,authorization,binding.artifactOrigins)}:{}),
  });
}
