import type {CapabilityManifestV2,Control,Port} from './types';

export type CloudFeature='image-create'|'image-edit'|'image-angles'|'image-relight'|'video-create'|'video-edit'|'replace-character'|'motion-transfer'|'restyle'|'object-swap'|'openjutsu'|'unsupported';
export type RouterModel={id:string;model:string;title:string;features:CloudFeature[];kind:'flux'|'seedance'|'kling-edit'|'kling-motion'|'h3-reference';output:'image'|'video';inputs:Port[];controls:Control[]};
const prompt:Control={id:'prompt',label:'Prompt',type:'string',default:'',apiField:'prompt'};
const seed:Control={id:'seed',label:'Seed',type:'integer',default:1,min:0,max:2147483647,apiField:'seed'};
const image=(id:string,label:string,required=false):Port=>({id,label,type:'image',required});
const video:Port={id:'source_video',label:'Your video',type:'video',required:true};
const reference=[image('reference_image','Character or reference'),image('reference_image_2','Second reference')];
const fluxControls:Control[]=[prompt,{id:'width',label:'Width',type:'integer',default:1024,min:256,max:2048,apiField:'width'},{id:'height',label:'Height',type:'integer',default:1024,min:256,max:2048,apiField:'height'},seed];
const klingControls:Control[]=[prompt,{id:'mode',label:'Quality',type:'select',options:['std','pro'],default:'std',apiField:'mode'}];
/** Reviewed contracts, not a blanket forwarding of Router's catalog. No model is substituted. */
export const ROUTER_MODELS:RouterModel[]=[
 {id:'router-h3-reference',model:'minimax/minimax-h3',title:'MiniMax H3 Reference',features:['openjutsu'],kind:'h3-reference',output:'video',inputs:[video,image('reference_image','Character',true),image('reference_image_2','Scene reference (optional)')],controls:[{...prompt,default:'Keep the reference performance, camera and scene.'},{id:'duration',label:'Seconds',type:'integer',default:5,min:5,max:15,apiField:'duration'},{id:'resolution',label:'Quality',type:'select',options:['768P'],default:'768P',apiField:'resolution'},{...seed,max:4294967295}]},
 {id:'router-flux-create',model:'bfl/flux-2-pro',title:'FLUX 2 Pro',features:['image-create'],kind:'flux',output:'image',inputs:[],controls:fluxControls},
 {id:'router-flux-edit',model:'bfl/flux-2-pro',title:'FLUX 2 Pro',features:['image-edit','image-angles','image-relight'],kind:'flux',output:'image',inputs:[image('source_image','Your image',true),...reference],controls:fluxControls},
 {id:'router-seedance-create',model:'byteplus/dreamina-seedance-2-5-260628',title:'Seedance 2.5',features:['video-create'],kind:'seedance',output:'video',inputs:[image('start_image','First frame')],controls:[prompt,{id:'duration',label:'Seconds',type:'integer',min:4,max:30,default:5,apiField:'duration'},{id:'resolution',label:'Size',type:'select',options:['480p','720p','1080p'],default:'480p',apiField:'resolution'},seed]},
 {id:'router-kling-edit',model:'kling/kling-v3-omni',title:'Kling V3 Omni',features:['video-edit','replace-character','restyle','object-swap'],kind:'kling-edit',output:'video',inputs:[video,...reference],controls:klingControls},
 {id:'router-kling-motion',model:'kling/kling-v3-omni',title:'Kling V3 Omni',features:['motion-transfer'],kind:'kling-motion',output:'video',inputs:[video,image('reference_image','Character',true)],controls:[...klingControls,{id:'duration',label:'Seconds',type:'select',options:['3','5','10'],default:'5',apiField:'duration'}]},
];
export const routerModelsFor=(feature:CloudFeature)=>ROUTER_MODELS.filter(m=>m.features.includes(feature));
/** Asset metadata is measured by the local upload/import path, never supplied in a run request. */
export function routerInputProblem(m:RouterModel,assets:Record<string,{content_type:string;bytes:number|string;metadata?:Record<string,unknown>}>):string|undefined{
 if(assets.reference_image_2&&!assets.reference_image)return 'Add the first reference before the second so reference numbering stays consistent.';
 let imageBytes=0;
 for(const [role,a] of Object.entries(assets)){
  if(a.content_type.startsWith('image/')){
   if(m.kind==='h3-reference'){if(!['image/png','image/jpeg','image/webp','image/gif'].includes(a.content_type))return 'Add a readable reference image.';continue;}
   imageBytes+=Number(a.bytes);if(!['image/png','image/jpeg'].includes(a.content_type))return 'Use PNG or JPEG references for this cloud model.';
   if(m.kind.startsWith('kling')){const w=Number(a.metadata?.width),h=Number(a.metadata?.height),minimum=300;if(!w||!h||Math.min(w,h)<minimum||w/h>2.5||h/w>2.5)return `Kling references need at least ${minimum} pixels on each side and an aspect ratio between 1:2.5 and 2.5:1.`;}
  }else if(role==='source_video'){
   const meta=a.metadata??{},duration=Number(meta.durationSeconds),edge=Math.min(Number(meta.width),Number(meta.height)),[n,d=1]=String(meta.frameRate??'').split('/').map(Number),fps=n/d;
   if(m.kind==='h3-reference'){
    // Normal uploads do not always carry probe metadata. The H3 preparation
    // validates the actual bytes before any provider submission; missing metadata
    // must not block a convertible file from reaching that preparation step.
    if(!['video/mp4','video/quicktime','video/webm'].includes(a.content_type)||(meta.durationSeconds!==undefined&&(!Number.isFinite(duration)||duration<=0))||(meta.width!==undefined&&(!Number.isFinite(Number(meta.width))||Number(meta.width)<=0))||(meta.height!==undefined&&(!Number.isFinite(Number(meta.height))||Number(meta.height)<=0))||(meta.frameRate!==undefined&&(!Number.isFinite(fps)||fps<=0)))return 'H3 needs a readable video with at least one frame.';
    continue;
   }
   if(!['video/mp4','video/quicktime'].includes(a.content_type)||Number(a.bytes)>200*1024*1024||!Number.isFinite(duration)||duration<3||!Number.isFinite(edge)||edge<720||edge>2160||!Number.isFinite(fps)||fps<24||fps>60)return Number.isFinite(edge)&&Number.isFinite(fps)&&Number.isFinite(duration)?`Kling needs an MP4 or MOV of at least 3 seconds (longer clips are cut to the first 10), 720p–2160p, 24–60 fps, up to 200 MB. This clip is ${Number(meta.width)}×${Number(meta.height)}, ${Math.round(fps*100)/100} fps, ${Math.round(duration*10)/10} s.`:'Kling needs a measured MP4 or MOV: at least 3 seconds (longer clips are cut to the first 10), 720p–2160p, 24–60 fps, up to 200 MB. Upload a compatible clip first.';
  }
 }
 if(imageBytes>10*1024*1024)return 'Use no more than 10 MB of reference images combined.';
}
/** Describe time changes before a reference clip is sent for preparation. */
export function h3ReferenceDurationNote(value:unknown):string|undefined {
 const duration=Number(value);
 if(!Number.isFinite(duration)||duration<=0)return 'If this video is longer than 15 seconds, the first 15 seconds will be used. Trim it to choose another part.';
 if(duration<2)return 'The final frame will be held to make this clip 2 seconds.';
 if(duration>15)return 'The first 15 seconds will be used. Trim the video to choose another part.';
 return undefined;
}
export function cloudFeature(route:string,videoMode:string,imageTab:string,changeChoice='person'):CloudFeature{
 if(route==='openjutsu')return 'openjutsu';
 if(route==='motion')return 'motion-transfer';
 if(route==='image')return imageTab==='create'?'image-create':imageTab==='angles'?'image-angles':imageTab==='relight'?'image-relight':'image-edit';
 if(route==='imageedit')return 'image-edit';
 if(route==='video'||route==='motion'){
  if(videoMode==='create')return 'video-create';
  if(videoMode==='replace')return 'replace-character';
  if(videoMode==='transform')return changeChoice==='person'?'replace-character':changeChoice==='motion'?'motion-transfer':changeChoice==='swap'||changeChoice==='object'?'object-swap':'restyle';
  if(videoMode==='edit')return 'video-edit';
 }
 return 'unsupported';
}
export function routerManifest(m:RouterModel):CapabilityManifestV2{
 return {schemaVersion:2,id:m.id,version:'1.0.0',title:`${m.title} · Comfy Router`,category:m.output==='image'?'image':'motion',description:`${m.title} through Comfy Router using your workspace API key. Charged to your Comfy credit balance. Price depends on model and input; estimate unavailable.`,inputs:m.inputs,outputs:[{id:'output',label:'Result',type:m.output,required:true}],controls:m.controls,presets:[],routes:[{id:'router',execution:'direct_provider',provider:'comfy-router',upstreamProviders:[m.model.split('/')[0]],implementation:'implemented',requirements:[],endpointOrigin:'https://api.comfy.org',evidence:['Input/output schemas read without generation on 2026-10-27. Mocked protocol qualification; live quality not verified.']}],coverage:{local:'planned',hosted:'implemented'},licenses:{software:'Provider API',weights:[]},sources:[{url:`https://api.comfy.org/v2/models/${m.model}/openapi.json`,observedAt:'2026-10-27',kind:'implementation'}],tickets:[],audioPolicies:m.kind==='h3-reference'?['replace']:['mute']};
}
