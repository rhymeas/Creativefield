import type {CapabilityManifestV2,Control,Port} from './types';

export type CloudFeature='image-cutout'|'video-cutout'|'talk'|'effects'|'keyframes'|'video-upscale'|'image-upscale'|'image-create'|'image-edit'|'image-angles'|'image-relight'|'video-create'|'video-edit'|'replace-character'|'motion-transfer'|'restyle'|'object-swap'|'openjutsu'|'unsupported';
export type RouterModel={id:string;model:string;title:string;features:CloudFeature[];kind:'flux'|'seedance'|'kling-edit'|'kling-motion'|'h3-reference'|'bfl-video-upscale'|'bria-upscale'|'h3-effect'|'h3-create'|'kling-lipsync'|'bria-cutout'|'bria-video-cutout';output:'image'|'video';inputs:Port[];controls:Control[]};
const prompt:Control={id:'prompt',label:'Prompt',type:'string',default:'',apiField:'prompt'};
const seed:Control={id:'seed',label:'Seed',type:'integer',default:1,min:0,max:2147483647,apiField:'seed'};
const image=(id:string,label:string,required=false):Port=>({id,label,type:'image',required});
const video:Port={id:'source_video',label:'Your video',type:'video',required:true};
const reference=[image('reference_image','Character or reference'),image('reference_image_2','Second reference')];
const fluxControls:Control[]=[prompt,{id:'width',label:'Width',type:'integer',default:1024,min:256,max:2048,apiField:'width'},{id:'height',label:'Height',type:'integer',default:1024,min:256,max:2048,apiField:'height'},seed];
const klingControls:Control[]=[prompt,{id:'mode',label:'Quality',type:'select',options:['std','pro'],default:'std',apiField:'mode'}];
/** The effects of the local MiniMax H3 effects workflow (native-workflows/h3-effects presets). */
export const H3_EFFECTS:{id:string;title:string;prompt:string}[]=[
 {id:'fire_breath',title:'Fire breath',prompt:'The person in the picture takes a deep breath and breathes a huge stream of fire toward the camera.'},
 {id:'bullet_time',title:'Bullet time',prompt:'The person in the picture leaps into the air; time freezes mid-jump and the camera circles around them in bullet time.'},
 {id:'blooming_flowers',title:'Blooming flowers',prompt:'Flowers bloom and grow all around the person in the picture until they are surrounded by blossoms.'},
 {id:'four_seasons',title:'Four seasons',prompt:'The seasons change around the person in the picture: spring blossoms, summer sun, autumn leaves and winter snow.'},
 {id:'kiss_camera',title:'Kiss to camera',prompt:'The person in the picture leans toward the camera, smiles and blows a kiss.'},
 {id:'storm_magic',title:'Storm magic',prompt:'The person in the picture calls down a storm; lightning crackles and wind whips around them.'},
 {id:'truman_show',title:'Film set reveal',prompt:'The person in the picture walks forward and touches the sky, which turns out to be a painted wall of a giant film set.'},
];
/** Kling lip-sync's English voices, as listed by ComfyUI's official Kling lip-sync node (comfy_api_nodes/nodes_kling.py). */
export const KLING_VOICES:{name:string;id:string}[]=[['Melody','girlfriend_4_speech02'],['Sunny','genshin_vindi2'],['Sage','zhinen_xuesheng'],['Ace','AOT'],['Blossom','ai_shatang'],['Peppy','genshin_klee2'],['Dove','genshin_kirara'],['Shine','ai_kaiya'],['Anchor','oversea_male1'],['Lyric','ai_chenjiahao_712'],['Tender','chat1_female_new-3'],['Siren','chat_0407_5-1'],['Zippy','cartoon-boy-07'],['Bud','uk_boy1'],['Sprite','cartoon-girl-01'],['Candy','PeppaPig_platform'],['Beacon','ai_huangzhong_712'],['Rock','ai_huangyaoshi_712'],['Titan','ai_laoguowang_712'],['Grace','chengshu_jiejie'],['Helen','you_pingjing'],['Lore','calm_story1'],['Crag','uk_man2'],['Prattle','laopopo_speech02'],['Hearth','heainainai_speech02'],['The Reader','reader_en_m-v1'],['Commercial Lady','commercial_lady_en_f-v1']].map(([name,id])=>({name,id}));
/** Reviewed contracts, not a blanket forwarding of Router's catalog. No model is substituted. */
export const ROUTER_MODELS:RouterModel[]=[
 {id:'router-h3-reference',model:'minimax/minimax-h3',title:'MiniMax H3 Reference',features:['openjutsu'],kind:'h3-reference',output:'video',inputs:[video,image('reference_image','Character',true),image('reference_image_2','Scene reference (optional)')],controls:[{...prompt,default:'Keep the reference performance, camera and scene.'},{id:'duration',label:'Seconds',type:'integer',default:5,min:5,max:15,apiField:'duration'},{id:'resolution',label:'Quality',type:'select',options:['768P'],default:'768P',apiField:'resolution'},{...seed,max:4294967295}]},
 {id:'router-flux-create',model:'bfl/flux-2-pro',title:'FLUX 2 Pro',features:['image-create'],kind:'flux',output:'image',inputs:[],controls:fluxControls},
 {id:'router-flux-edit',model:'bfl/flux-2-pro',title:'FLUX 2 Pro',features:['image-edit','image-angles','image-relight'],kind:'flux',output:'image',inputs:[image('source_image','Your image',true),...reference],controls:fluxControls},
 /* Make it talk: Kling lip-sync in text mode, from its Router OpenAPI document (video 2-10 s, text up to 120 characters, a Kling voice). */
 {id:'router-kling-talk',model:'kling/videos-lip-sync',title:'Kling Lip Sync',features:['talk'],kind:'kling-lipsync',output:'video',inputs:[video],controls:[{id:'voice',label:'Voice',type:'select',options:KLING_VOICES.map(v=>v.name),default:'Anchor',apiField:'voice_id'},{...prompt,label:'What they say (up to 120 characters)'},{id:'voice_speed',label:'Speed',type:'select',options:[0.8,1,1.2,1.5],default:1,apiField:'voice_speed'}]},
 /* The local h3-effects workflow's presets, without its local embedding token: one photo, one effect, on MiniMax H3. */
 {id:'router-h3-effects',model:'minimax/minimax-h3',title:'MiniMax H3 Effects',features:['effects'],kind:'h3-effect',output:'video',inputs:[image('start_image','Photo',true)],controls:[{id:'effect',label:'Effect',type:'select',options:H3_EFFECTS.map(e=>e.title),default:H3_EFFECTS[0].title,apiField:'effect'},{...prompt,label:'Add to the effect (optional)'},{id:'duration',label:'Seconds',type:'integer',default:5,min:4,max:15,apiField:'duration'},{id:'resolution',label:'Quality',type:'select',options:['768P','2K'],default:'768P',apiField:'resolution'},{...seed,max:4294967295}]},
 /* Upscalers, from each model's Router OpenAPI document (GET /v2/models/<id>/openapi.json). BFL takes up to 20 s and 50 MB of video. */
 {id:'router-video-upscale',model:'bfl/video-upscale-v1',title:'FLUX Video Upscale',features:['video-upscale'],kind:'bfl-video-upscale',output:'video',inputs:[video],controls:[{...prompt,label:'Describe the clip (optional)'},{id:'upscale_factor',label:'Scale',type:'select',options:[1.5,2,3],default:2,apiField:'upscale_factor'},{id:'creativity',label:'Detail',type:'select',options:[0,1],default:0,apiField:'creativity'}]},
 /* Background removal, from Bria's Router OpenAPI documents: a picture as base64 (PNG with alpha back), a clip up to 60 s on a plain colour. */
 {id:'router-image-cutout',model:'bria/image-edit-remove-background',title:'Bria Remove Background',features:['image-cutout'],kind:'bria-cutout',output:'image',inputs:[image('source_image','Your image',true)],controls:[]},
 {id:'router-video-cutout',model:'bria/video-edit-remove-background',title:'Bria Video Background Removal',features:['video-cutout'],kind:'bria-video-cutout',output:'video',inputs:[video],controls:[{id:'background_color',label:'Background',type:'select',options:['Green','White','Black','Blue','Gray'],default:'Green',apiField:'background_color'}]},
 {id:'router-image-upscale',model:'bria/image-edit-increase-resolution',title:'Bria Upscale',features:['image-upscale'],kind:'bria-upscale',output:'image',inputs:[image('source_image','Your image',true)],controls:[{id:'desired_increase',label:'Scale',type:'select',options:[2,4],default:2,apiField:'desired_increase'}]},
 /* First and last frame of one keyframe segment: Seedance takes both as content images with these roles. */
 {id:'router-seedance-keyframes',model:'byteplus/dreamina-seedance-2-5-260628',title:'Seedance 2.5 · first and last frame',features:['keyframes'],kind:'seedance',output:'video',inputs:[image('start_image','First frame',true),image('end_image','Last frame',true)],controls:[prompt,{id:'duration',label:'Seconds',type:'integer',min:4,max:30,default:5,apiField:'duration'},{id:'resolution',label:'Size',type:'select',options:['480p','720p','1080p'],default:'720p',apiField:'resolution'},seed]},
 /* MiniMax H3 with a first and a last frame, the same request as H3 create with a last_frame image. */
 {id:'router-h3-keyframes',model:'minimax/minimax-h3',title:'MiniMax H3 · first and last frame',features:['keyframes'],kind:'h3-create',output:'video',inputs:[image('start_image','First frame',true),image('end_image','Last frame',true)],controls:[prompt,{id:'duration',label:'Seconds',type:'integer',default:5,min:4,max:15,apiField:'duration'},{id:'resolution',label:'Size',type:'select',options:['768P','2K'],default:'768P',apiField:'resolution'},{...seed,max:4294967295}]},
 {id:'router-seedance-create',model:'byteplus/dreamina-seedance-2-5-260628',title:'Seedance 2.5',features:['video-create'],kind:'seedance',output:'video',inputs:[image('start_image','First frame')],controls:[prompt,{id:'duration',label:'Seconds',type:'integer',min:4,max:30,default:5,apiField:'duration'},{id:'resolution',label:'Size',type:'select',options:['480p','720p','1080p'],default:'480p',apiField:'resolution'},seed]},
 /* MiniMax H3 through the Router: a prompt, and a first frame when one is given. Same request shape as the effects above. */
 {id:'router-h3-create',model:'minimax/minimax-h3',title:'MiniMax H3',features:['video-create'],kind:'h3-create',output:'video',inputs:[image('start_image','First frame')],controls:[prompt,{id:'duration',label:'Seconds',type:'integer',default:5,min:4,max:15,apiField:'duration'},{id:'resolution',label:'Size',type:'select',options:['768P','2K'],default:'768P',apiField:'resolution'},{...seed,max:4294967295}]},
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
   if(m.kind==='h3-reference'||m.kind==='h3-effect'||m.kind==='h3-create'){if(!['image/png','image/jpeg','image/webp','image/gif'].includes(a.content_type))return 'Add a readable reference image.';continue;}
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
   if(m.kind==='bria-video-cutout'){if(!['video/mp4','video/quicktime'].includes(a.content_type))return 'Background removal takes an MP4 or MOV; longer clips are cut to their first 60 seconds.';continue;}
   /* Kling lip-sync: 720-1920 px on each side, up to 100 MB; longer clips are cut to 10 s. */
   if(m.kind==='kling-lipsync'){const w=Number(meta.width),h=Number(meta.height);if(!['video/mp4','video/quicktime'].includes(a.content_type)||Number(a.bytes)>100*1024*1024||Number.isFinite(w)&&Number.isFinite(h)&&(Math.min(w,h)<720||Math.max(w,h)>1920))return `Kling Lip Sync needs an MP4 or MOV of up to 100 MB with 720–1920 pixels on each side.${Number.isFinite(w)&&Number.isFinite(h)?` This clip is ${w}×${h}.`:''}`;continue;}
   /* FLUX Video Upscale is for small clips: any size, the first 20 s are sent, the file at most 50 MB. */
   if(m.kind==='bfl-video-upscale'){if(!['video/mp4','video/quicktime'].includes(a.content_type)||Number(a.bytes)>50*1024*1024)return 'FLUX Video Upscale takes an MP4 or MOV of up to 50 MB; longer clips are cut to their first 20 seconds.';continue;}
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
 if(route==='audio')return 'talk';
 if(route==='motion')return 'motion-transfer';
 if(route==='image')return imageTab==='create'?'image-create':imageTab==='upscale'?'image-upscale':imageTab==='cutout'?'image-cutout':imageTab==='angles'?'image-angles':imageTab==='relight'?'image-relight':'image-edit';
 if(route==='imageedit')return 'image-edit';
 if(route==='video'||route==='motion'){
  if(videoMode==='create')return 'video-create';
  if(videoMode==='effects')return 'effects';
  if(videoMode==='replace')return 'replace-character';
  if(videoMode==='transform')return changeChoice==='person'?'replace-character':changeChoice==='motion'?'motion-transfer':changeChoice==='swap'||changeChoice==='object'?'object-swap':changeChoice==='upscale'?'video-upscale':changeChoice==='cutout'?'video-cutout':'restyle';
  if(videoMode==='edit')return 'video-edit';
 }
 return 'unsupported';
}
export function routerManifest(m:RouterModel):CapabilityManifestV2{
 return {schemaVersion:2,id:m.id,version:'1.0.0',title:`${m.title} · Comfy Router`,category:m.output==='image'?'image':'motion',description:`${m.title} through Comfy Router using your workspace API key. Charged to your Comfy credit balance. Price depends on model and input; estimate unavailable.`,inputs:m.inputs,outputs:[{id:'output',label:'Result',type:m.output,required:true}],controls:m.controls,presets:[],routes:[{id:'router',execution:'direct_provider',provider:'comfy-router',upstreamProviders:[m.model.split('/')[0]],implementation:'implemented',requirements:[],endpointOrigin:'https://api.comfy.org',evidence:['Input/output schemas read without generation on 2026-10-27. Mocked protocol qualification; live quality not verified.']}],coverage:{local:'planned',hosted:'implemented'},licenses:{software:'Provider API',weights:[]},sources:[{url:`https://api.comfy.org/v2/models/${m.model}/openapi.json`,observedAt:'2026-10-27',kind:'implementation'}],tickets:[],audioPolicies:m.kind==='h3-reference'?['replace']:['mute']};
}
