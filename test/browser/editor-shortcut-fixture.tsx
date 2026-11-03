import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {ToastHost} from '../../src/ds';
import {ImageEditor} from '../../src/image/editor/ImageEditor';
import raw from '../../native-workflows/fibo2-edit/manifest.json';
import type {CapabilityManifestV2} from '../../src/capabilities/types';
import type {Call,Project,Workspace} from '../../src/team/api';
import '../../src/ds/tokens.css';
import '../../src/ds/components.css';
import '../../src/team/team.css';
const assets=['first','second'].map(id=>({id,project_id:'editor-fixture',name:`${id}.png`,media_type:'image',content_type:'image/png',bytes:'1',created_at:'2026-01-01',parent_id:null}));
const call=(async (url:string,method?:string,body?:unknown)=>{if(method==='POST'&&url.endsWith('/runs')){document.getElementById('captured')!.textContent=JSON.stringify(body);return {id:'simulated-run'};}if(method==='POST'&&url.includes('assets?'))return {...assets[0],id:'source-canvas'};if(url.includes('/runs?'))return [{id:'simulated-run',state:'failed',error:'Fixture stops before rendering',output_ids:[]}];return url.endsWith('/editor-documents')?[]:url.includes('assets?')?{items:assets,nextCursor:null}:[];}) as Call;
function Fixture(){const [available,setAvailable]=useState(true),params=new URLSearchParams(location.search),route={manifest:raw as unknown as CapabilityManifestV2,workerId:'w',routeId:'local'};return <>{params.has('segment-toggle')&&<button onClick={()=>setAvailable(false)}>Disable segmentation</button>}<ImageEditor workspace={{id:'editor-fixture',role:'creator'} as Workspace} project={{id:'editor-fixture'} as Project} userId="editor-fixture" call={call} canEdit authorized={params.has('authorized')} edit={params.has('references')?route:undefined} segment={params.has('segment-toggle')&&available?route:undefined}/></>;}
createRoot(document.getElementById('root')!).render(<ToastHost><Fixture/></ToastHost>);
