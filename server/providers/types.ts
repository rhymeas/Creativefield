import type {Readable} from "node:stream";
import type {Invocation} from "../../src/capabilities/types";

/** Server-owned metadata. No secrets, signed URLs or caller-selected endpoints. */
export type DirectBinding = Readonly<{
  capabilityId:string; capabilityVersion:string; routeId:string;
  adapterId:string; adapterVersion:string; provider:string; model:string;
  upstreamProviders:readonly string[]; apiOrigins:readonly string[]; artifactOrigins:readonly string[];
}>;
export type AdapterErrorCode = "invalid_input"|"rejected"|"unavailable"|"unauthorized"|"unknown";
export type Estimate = {kind:"unknown"}|{kind:"estimate";currency:string;amount:number;basis:string};
export type Submission = {kind:"accepted";remoteId:string}|{kind:"rejected";code:AdapterErrorCode}|{kind:"unknown"};
export type Observation = {state:"pending"|"running"|"succeeded"|"canceled"}|{state:"failed";code:AdapterErrorCode};
export type Cancellation = {kind:"accepted"|"confirmed"|"unsupported"|"unknown"};
export type Recovery = {kind:"found";remoteId:string}|{kind:"unresolved"|"unsupported"};
/** Download locations are transient; callers must never persist/log their values. */
export type TransientOutput = {url:string;mediaType:"video"|"image";contentType:string};
export type OwnedInput = {role:string;contentType:string;bytes:number;open:()=>Promise<Readable>};
export type PreparedInputs = Readonly<Record<string,unknown>>;
export type AdapterTransport = {
  api(path:string,options?:{method?:"GET"|"POST"|"PUT"|"DELETE";body?:unknown;origin?:string;idempotencyKey?:string}):Promise<unknown>;
  artifact(url:string,maxBytes:number):Promise<{body:Readable;contentType:string}>;
  upload?(input:OwnedInput):Promise<string>;
};
export type AdapterContext = {requestId:string;binding:DirectBinding;transport:AdapterTransport};
/** Implementations must normalize raw responses; no provider text belongs in errors/events. */
export interface DirectAdapter {
  readonly id:string; readonly version:string; readonly provider:string;
  readonly recovery:"lookup"|"unsupported"; readonly cancellation:"supported"|"unsupported";
  validate(invocation:Invocation):{valid:true}|{valid:false;code:AdapterErrorCode};
  estimate(invocation:Invocation):Promise<Estimate>;
  prepareInputs(inputs:readonly OwnedInput[],context:AdapterContext):Promise<PreparedInputs>;
  submit(invocation:Invocation,inputs:PreparedInputs,context:AdapterContext):Promise<Submission>;
  poll(remoteId:string,context:AdapterContext):Promise<Observation>;
  cancel(remoteId:string,context:AdapterContext):Promise<Cancellation>;
  recover(context:AdapterContext):Promise<Recovery>;
  outputs(remoteId:string,context:AdapterContext):Promise<readonly TransientOutput[]>;
}
