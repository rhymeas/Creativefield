import {createHash} from "node:crypto";
import {isIP} from "node:net";
import {assertIndependentProvider,forbiddenProvider} from "../../src/capabilities/policy";
import type {CapabilityManifestV2} from "../../src/capabilities/types";
import type {DirectAdapter,DirectBinding} from "./types";
import {routerRegistrations} from './comfy-router';

export function approvedOrigin(value:string):string {
  let url:URL;try{url=new URL(value);}catch{throw new Error("Invalid provider origin");}
  if(url.protocol!=="https:"||url.port||url.username||url.password||url.pathname!=="/"||url.search||url.hash||isIP(url.hostname)||url.hostname.endsWith(".")||forbiddenProvider(url.hostname)||!url.hostname.includes(".")||url.hostname.length>253||url.hostname.split(".").some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw new Error("Invalid provider origin");
  return url.origin;
}
const identity=(v:string)=>typeof v==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(v)&&!forbiddenProvider(v);
export function freezeBinding(value:DirectBinding):DirectBinding {
  if(![value.capabilityId,value.capabilityVersion,value.routeId,value.adapterId,value.adapterVersion,value.model].every(identity))throw new Error("Invalid adapter binding identity");
  assertIndependentProvider(value.provider,[...value.upstreamProviders]);
  if(value.provider==='comfy-router'){
    if(!value.apiOrigins.includes('https://api.comfy.org')||value.apiOrigins.some(o=>!['https://api.comfy.org','https://cloud.comfy.org'].includes(o))||value.upstreamProviders.length!==1||!value.model.startsWith(`${value.upstreamProviders[0]}/`))throw new Error('Invalid Comfy Router binding');
  }else if([value.provider,...value.upstreamProviders].some(p=>p.startsWith("comfy-")))throw new Error("Direct adapters require independent model providers");
  if(!value.apiOrigins.length)throw new Error("Adapter has no API origin");
  const origins=(list:readonly string[])=>Object.freeze([...new Set(list.map(approvedOrigin))].sort());
  // Copy allowlisted fields instead of preserving extra fields from a caller object.
  return Object.freeze({capabilityId:value.capabilityId,capabilityVersion:value.capabilityVersion,routeId:value.routeId,adapterId:value.adapterId,adapterVersion:value.adapterVersion,provider:value.provider,model:value.model,upstreamProviders:Object.freeze([...new Set(value.upstreamProviders)].sort()),apiOrigins:origins(value.apiOrigins),artifactOrigins:origins(value.artifactOrigins)});
}
export function bindingHash(binding:DirectBinding):string {return createHash("sha256").update(JSON.stringify(freezeBinding(binding))).digest("hex");}
export type Registration = {binding:DirectBinding;adapter:DirectAdapter;qualified:boolean};
export type RegisteredAdapter = Readonly<{binding:DirectBinding;adapter:DirectAdapter;hash:string}>;
const key=(id:string,version:string,route:string)=>JSON.stringify([id,version,route]);
export class DirectRegistry {
  readonly #entries=new Map<string,RegisteredAdapter>();
  constructor(registrations:readonly Registration[]=[]){
    for(const entry of registrations){
      const binding=freezeBinding(entry.binding),adapter=entry.adapter;
      if(!entry.qualified||adapter.id!==binding.adapterId||adapter.version!==binding.adapterVersion||adapter.provider!==binding.provider)throw new Error("Adapter registration is not qualified for this binding");
      const id=key(binding.capabilityId,binding.capabilityVersion,binding.routeId);
      if(this.#entries.has(id))throw new Error("Duplicate provider route binding");
      // Snapshot method references too; mutating the registration later cannot replace them.
      const snapshot:DirectAdapter=Object.freeze({id:adapter.id,version:adapter.version,provider:adapter.provider,recovery:adapter.recovery,cancellation:adapter.cancellation,
        validate:adapter.validate.bind(adapter),estimate:adapter.estimate.bind(adapter),prepareInputs:adapter.prepareInputs.bind(adapter),submit:adapter.submit.bind(adapter),poll:adapter.poll.bind(adapter),cancel:adapter.cancel.bind(adapter),recover:adapter.recover.bind(adapter),outputs:adapter.outputs.bind(adapter)});
      this.#entries.set(id,Object.freeze({binding,adapter:snapshot,hash:bindingHash(binding)}));
    }
  }
  resolve(manifest:CapabilityManifestV2,routeId:string):RegisteredAdapter|null {
    const route=manifest.routes.find(r=>r.id===routeId),entry=this.#entries.get(key(manifest.id,manifest.version,routeId));
    if(!entry||!route||route.execution!=="direct_provider"||route.implementation!=="implemented"||route.provider!==entry.binding.provider)return null;
    if(JSON.stringify([...new Set(route.upstreamProviders)].sort())!==JSON.stringify(entry.binding.upstreamProviders))return null;
    if(route.endpointOrigin){try{if(!entry.binding.apiOrigins.includes(approvedOrigin(route.endpointOrigin)))return null;}catch{return null;}}
    return entry;
  }
  get size(){return this.#entries.size;}
}
/** Reviewed Router contracts; qualifications are mocked protocol checks, not output-quality claims. */
export const productionDirectRegistry=new DirectRegistry(routerRegistrations);
