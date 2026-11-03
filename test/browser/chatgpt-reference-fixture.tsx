import {createRoot} from 'react-dom/client';
import {ChatgptImageStudio} from '../../src/team/ChatgptImageStudio';
import type {Asset,Call} from '../../src/team/api';
import '../../src/ds/tokens.css';import '../../src/ds/components.css';import '../../src/team/team.css';
const asset=(id:string):Asset=>({id,project_id:'p',name:`${id}.png`,media_type:'image',content_type:'image/png',bytes:'1',created_at:'2026-01-01',parent_id:null});
const assets=[asset('one'),asset('two')];
const call:Call=async(url,method,body)=>{if(method==='POST'&&url.endsWith('/chatgpt-image/runs')){document.getElementById('submitted')!.textContent=JSON.stringify(body);return {} as never;}if(url.endsWith('/chatgpt-image/account'))return {connected:true} as never;return url.includes('assets?')?{items:assets,nextCursor:null} as never:url.includes('assets/')?assets.find(a=>url.includes(a.id)) as never:[] as never;};
createRoot(document.getElementById('root')!).render(<ChatgptImageStudio feature="image-edit" workspace={{id:'w',name:'Studio',role:'admin'}} project={{id:'p',name:'Test'}} user={{id:'u',email:'u@example.test'}} call={call} version={0} canEdit onQueued={()=>{}} incoming={{inputs:{source_image:'one',reference_image:'two'},prompt:'Replace person now'}}/>);
