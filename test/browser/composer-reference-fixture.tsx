import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import raw from '../../native-workflows/openjutsu-h3-swap/manifest.json';
import type {CapabilityManifestV2} from '../../src/capabilities/types';
import type {Asset,Call} from '../../src/team/api';
import {TeamComposer} from '../../src/team/TeamComposer';
import {EXAMPLE_DRAG} from '../../src/ds/example-media';
import {MediaCard} from '../../src/ds';
import '../../src/ds/tokens.css';import '../../src/ds/components.css';import '../../src/team/team.css';
const original=raw as unknown as CapabilityManifestV2,character=original.inputs.find(input=>input.id==='character_image')!;
const manifest:CapabilityManifestV2={...original,inputs:[original.inputs.find(input=>input.id==='source_video')!,{...character,id:'reference_image',label:'Reference 1'},{...character,id:'reference_image_2',label:'Reference 2',required:false}],routes:original.routes.map(route=>({...route,requirements:[]}))};
const asset=(id:string,type:'image'|'video'):Asset=>({id,project_id:'p',name:`${id}.${type==='image'?'png':'mp4'}`,media_type:type,content_type:type==='image'?'image/png':'video/mp4',bytes:'1',created_at:'2026-01-01',parent_id:null});
const assets=[asset('one','image'),asset('two','image'),asset('clip','video')],old=asset('old','image');
let releaseOld:(()=>void)|undefined,uploaded=0;
const event=(text:string)=>{document.getElementById('events')!.textContent+=`${text}\n`;};
const call:Call=async(url,method,body)=>{
 if(method==='POST'&&url.endsWith('/runs')){document.getElementById('submitted')!.textContent=JSON.stringify(body);return {id:'simulated-run'} as never;}
 if(method==='POST'&&url.includes('assets?')){const file=(body as FormData).get('file') as File,next={...asset(`uploaded-${++uploaded}`,'image'),name:file.name,content_type:file.type};assets.unshift(next);event(`upload:${file.name}:${next.id}`);return next as never;}
 if(url.includes('elements?'))return [{id:'person',name:'Saved person',kind:'character',description:'',created_at:'2026-01-01',asset_ids:['one'],assets:[assets.find(a=>a.id==='one')!]}] as never;
 if(url.includes('assets?'))return {items:assets,nextCursor:null} as never;
 if(url.includes('assets/old'))return new Promise(resolve=>{event('lookup:old:pending');releaseOld=()=>{event('lookup:old:released');resolve(old as never);};});
 if(url.includes('assets/'))return assets.find(a=>url.includes(a.id)) as never;
 return [] as never;
};
const worker={id:'worker',name:'Fixture',origin:'http://localhost:8188',enabled:true,checked_at:new Date().toISOString(),inventory:{online:true,nodes:[],models:[],credentials:[]}};
const initialInputs:Record<string,string>=location.search.includes('empty=1')?{source_video:'clip'}:location.search.includes('element=1')?{source_video:'clip',reference_image_2:'two'}:{source_video:'clip',reference_image:'one',reference_image_2:'two'};
function Fixture(){const [,refresh]=useState(0);return <><section aria-label="Controlled drag sources"><MediaCard title="Delayed project asset" dragAsset={{id:'old',url:'/api/v1/workspaces/w/assets/old/content',contentType:'image/png'}} media={<img src="/reels/feature-restyle.png" alt="Delayed asset"/>}/><div role="button" tabIndex={0} draggable onDragStart={e=>{e.dataTransfer.setData(EXAMPLE_DRAG,'/reels/feature-restyle.png');e.dataTransfer.effectAllowed='copy';}}>Bundled image example</div><button type="button" onClick={()=>{releaseOld?.();refresh(v=>v+1);}}>Release delayed asset lookup</button></section><TeamComposer manifest={manifest} catalogue={[manifest]} onCapability={()=>{}} user={{id:'u',email:'u@example.test'}} workspace={{id:'w',name:'Studio',role:'admin'}} project={{id:'p',name:'Test'}} workers={[worker]} call={call} canQueue authorized onQueued={()=>{}} initialInputs={initialInputs}/></>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
