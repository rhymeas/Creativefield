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
   imageBytes+=Number(a.bytes);if(!['image/png','image/jpeg'].includes(a.content_type))return 'Use PNG or JPEG references for this cloud model.';
   if(m.kind.startsWith('kling')||m.kind==='h3-reference'){const w=Number(a.metadata?.width),h=Number(a.metadata?.height),minimum=m.kind==='h3-reference'?256:300;if(!w||!h||Math.min(w,h)<minimum||w/h>2.5||h/w>2.5)return `${m.kind==='h3-reference'?'H3':'Kling'} references need at least ${minimum} pixels on each side and an aspect ratio between 1:2.5 and 2.5:1.`;}
  }else if(role==='source_video'){
   const meta=a.metadata??{},duration=Number(meta.durationSeconds),edge=Math.min(Number(meta.width),Number(meta.height)),[n,d=1]=String(meta.frameRate??'').split('/').map(Number),fps=n/d;
   if(m.kind==='h3-reference'){
    if(!['video/mp4','video/quicktime'].includes(a.content_type)||Number(a.bytes)>100*1024*1024||!Number.isFinite(duration)||duration<2||duration>15||!Number.isFinite(edge)||edge<256||!Number.isFinite(fps)||fps<23.9||fps>60.5)return 'H3 needs a pre-trimmed MP4 or MOV: 2–15 seconds, 24–60 fps, at least 256 pixels on each side, up to 100 MB.';
    continue;
   }
   if(!['video/mp4','video/quicktime'].includes(a.content_type)||Number(a.bytes)>200*1024*1024||!Number.isFinite(duration)||duration<3||duration>10||!Number.isFinite(edge)||edge<720||edge>2160||!Number.isFinite(fps)||fps<24||fps>60)return 'Kling needs a measured MP4 or MOV: 3–10 seconds, 720p–2160p, 24–60 fps, up to 200 MB. Upload a compatible clip first.';
  }
 }
 if(imageBytes>10*1024*1024)return 'Use no more than 10 MB of reference images combined.';
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
