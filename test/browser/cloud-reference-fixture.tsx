import {createRoot} from 'react-dom/client';
import {CloudRenderStudio} from '../../src/team/CloudRenderStudio';
import type {Asset,Call} from '../../src/team/api';
import '../../src/ds/tokens.css';import '../../src/ds/components.css';import '../../src/team/team.css';
const asset=(id:string,type:'image'|'video'):Asset=>({id,project_id:'p',name:`${id}.${type==='image'?'png':'mp4'}`,media_type:type,content_type:type==='image'?'image/png':'video/mp4',bytes:'1',created_at:'2026-01-01',parent_id:null});
const assets=[asset('clip','video'),asset('one','image'),asset('two','image')];
const call:Call=async(url,method,body)=>{if(method==='POST'&&url.endsWith('/runs')){document.getElementById('submitted')!.textContent=JSON.stringify(body);return {} as never;}if(url.endsWith('/router-models'))return {connected:true} as never;return url.includes('assets?')?{items:assets,nextCursor:null} as never:url.includes('assets/')?assets.find(a=>url.includes(a.id)) as never:[] as never;};
createRoot(document.getElementById('root')!).render(<CloudRenderStudio feature="openjutsu" workspace={{id:'w',name:'Studio',role:'admin'}} project={{id:'p',name:'Test'}} user={{id:'u',email:'u@example.test'}} call={call} version={0} canEdit onQueued={()=>{}} onSettings={()=>{}} onLocal={()=>{}} incoming={{inputs:{source_video:'clip',reference_image:'one',reference_image_2:'two'},prompt:'Replace person now'}}/>);
