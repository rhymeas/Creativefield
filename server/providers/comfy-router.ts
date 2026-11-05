import {ROUTER_MODELS,routerManifest,type RouterModel} from '../../src/capabilities/router-models';
import type {Invocation} from '../../src/capabilities/types';
import type {DirectAdapter,OwnedInput,PreparedInputs} from './types';
import type {Registration} from './registry';
import {withH3Video} from './h3-video';
import {prepareH3Images} from './h3-image';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(v);
const root=(m:RouterModel)=>`/v2/models/${m.model}/requests`;
function requestPath(m:RouterModel,remoteId:string){if(!id(remoteId))throw new Error('Invalid request ID');return `${root(m)}/${encodeURIComponent(remoteId)}`;}
async function bytes(input:OwnedInput){const parts:Buffer[]=[];let n=0;for await(const c of await input.open()){const b=Buffer.from(c);n+=b.length;if(n>10*1024*1024)throw new Error('Reference exceeds 10 MB');parts.push(b);}return Buffer.concat(parts);}
function body(m:RouterModel,i:Invocation,p:PreparedInputs){
 const c=i.controls,prompt=String(c.prompt);
 if(m.kind==='flux')return {prompt,width:c.width,height:c.height,seed:c.seed,output_format:'png',prompt_upsampling:false,...Object.fromEntries(['source_image','reference_image','reference_image_2'].filter(k=>p[k]).map((k,n)=>[n?`input_image_${n+1}`:'input_image',p[k]]))};
 if(m.kind==='seedance')return {content:[{type:'text',text:prompt},...(p.start_image?[{type:'image_url',image_url:{url:p.start_image},role:'first_frame'}]:[])],duration:c.duration,resolution:c.resolution,seed:c.seed,generate_audio:false,watermark:false};
 if(m.kind==='h3-reference')return {content:[{type:'text',text:`Use the character in Image 1 for the person shown in Video 1. Follow the reference performance, camera and scene.${p.reference_image_2?' Image 2 is an additional scene reference.':''} ${prompt}`},{type:'video_url',video_url:{url:p.source_video},role:'reference_video'},...['reference_image','reference_image_2'].filter(k=>p[k]).map(k=>({type:'image_url',image_url:{url:p[k]},role:'reference_image'}))],duration:c.duration,resolution:c.resolution,seed:c.seed,ratio:'adaptive',aigc_watermark:false};
 const images=['reference_image','reference_image_2'].filter(k=>p[k]);
 return {prompt:prompt.replace(/@Image\s*([12])\b/gi,(match,n:string)=>Number(n)<=images.length?`<<<image_${n}>>>`:match).replace(/@Video\s*1\b/gi,'<<<video_1>>>'),mode:c.mode,sound:'off',video_list:[{video_url:p.source_video,refer_type:m.kind==='kling-edit'?'base':'feature',keep_original_sound:'no'}],image_list:images.map(k=>({image_url:p[k]})),...(m.kind==='kling-motion'?{duration:c.duration,aspect_ratio:'16:9'}:{})};
}
export function routerAdapter(m:RouterModel):DirectAdapter{
 return {id:`comfy-router-${m.kind}`,version:'1.0.0',provider:'comfy-router',recovery:'unsupported',cancellation:'supported',
  validate(i){
    const limit=m.kind==='h3-reference'?500:m.kind.startsWith('kling')?2500:20000,prompt=i.controls.prompt;
    const reason=typeof prompt!=='string'?'Write a prompt.':m.kind!=='h3-reference'&&!prompt.trim()?'Write a prompt.':prompt.length>limit?`${m.title} takes a prompt of up to ${limit} characters; this one has ${prompt.length}. Shorten it.`:i.audioPolicy!==(m.kind==='h3-reference'?'replace':'mute')?'This sound setting is not available for this model.':m.kind==='h3-reference'&&!(i.inputs.source_video&&i.inputs.reference_image)?'Add your video and a character picture.':undefined;
    return reason?{valid:false,code:'invalid_input',reason}:{valid:true};
  },
  async estimate(){return {kind:'unknown'};},
  async prepareInputs(inputs,context){const images=inputs.filter(i=>i.contentType.startsWith('image/'));if(m.kind!=='h3-reference'&&images.reduce((n,i)=>n+i.bytes,0)>10*1024*1024)throw new Error('References exceed 10 MB combined');const p:Record<string,string>=m.kind==='h3-reference'?await prepareH3Images(images):{};for(const input of inputs){if(input.contentType.startsWith('image/')){if(m.kind==='h3-reference')continue;if(!['image/png','image/jpeg'].includes(input.contentType))throw new Error('Use PNG or JPEG references');const b=await bytes(input);p[input.role]=m.kind==='seedance'?`data:${input.contentType};base64,${b.toString('base64')}`:b.toString('base64');}else{if(!context.transport.upload)throw new Error('Cloud media upload is unavailable');p[input.role]=m.kind==='h3-reference'&&input.role==='source_video'?await withH3Video(input,context.transport.upload):await context.transport.upload(input);}}return p;},
  async submit(i,p,context){try{const r=object(await context.transport.api(root(m),{method:'POST',body:body(m,i,p),idempotencyKey:context.requestId}));return id(r.request_id)?{kind:'accepted',remoteId:r.request_id}:{kind:'unknown'};}catch(e){const status=(e as {status?:number}).status;return status&&[400,401,402,403,422,429].includes(status)?{kind:'rejected',code:status===401?'unauthorized':'rejected'}:{kind:'unknown'};}},
  async poll(remote,context){const r=object(await context.transport.api(`${requestPath(m,remote)}/status`));if(r.status==='COMPLETED'){if(r.error_type)return r.error_type==='cancelled'||r.error_type==='canceled'?{state:'canceled'}:{state:'failed',code:'rejected'};return {state:'succeeded'};}if(r.status==='IN_QUEUE')return {state:'pending'};if(r.status==='IN_PROGRESS')return {state:'running'};throw new Error('Unknown Router status');},
  async cancel(remote,context){await context.transport.api(`${requestPath(m,remote)}/cancel`,{method:'PUT'});return {kind:'accepted'};},
  async recover(){return {kind:'unsupported'};},
  async outputs(remote,context){const r=object(await context.transport.api(requestPath(m,remote)));if(r.error_type||m.kind==='h3-reference'&&object(r.task).status!=='succeeded')throw new Error('Router result failed');const urls=m.kind==='flux'?[object(r.result).sample]:m.kind==='seedance'?[object(r.content).video_url]:m.kind==='h3-reference'?[object(object(r.task).content).url]:(object(object(r.data).task_result).videos??[]).map((v:any)=>v.url);if(!urls.length||urls.some((u:unknown)=>typeof u!=='string'||!u))throw new Error('Missing Router output');return urls.map((url:string)=>({url,mediaType:m.output,contentType:m.output==='image'?'image/png':'video/mp4'}));},
 };
}
export const routerRegistrations:Registration[]=ROUTER_MODELS.map(m=>({qualified:true,adapter:routerAdapter(m),binding:{capabilityId:m.id,capabilityVersion:'1.0.0',routeId:'router',adapterId:`comfy-router-${m.kind}`,adapterVersion:'1.0.0',provider:'comfy-router',model:m.model,upstreamProviders:[m.model.split('/')[0]],apiOrigins:['https://api.comfy.org','https://cloud.comfy.org'],artifactOrigins:['https://storage.googleapis.com','https://api.comfy.org','https://cloud.comfy.org','https://delivery-us1.bfl.ai','https://delivery-eu1.bfl.ai',...(m.kind.startsWith('kling')?['https://v16-kling.klingai.com','https://v21-kling.klingai.com','https://v26-kling.klingai.com','https://v16-kling-fdl.klingai.com','https://s21-kling.klingai.com']:[])]}}));
export const routerBundles=ROUTER_MODELS.map(m=>({manifest:routerManifest(m)}));
