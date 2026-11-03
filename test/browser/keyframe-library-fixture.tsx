import {createRoot} from 'react-dom/client';
import {KeyframeStudio} from '../../src/team/KeyframeStudio';
import type {Asset,Call} from '../../src/team/api';

const image=(id:string,name:string):Asset=>({id,project_id:'fixture',name,media_type:'image',content_type:'image/png',bytes:'1',created_at:'2026-01-01',parent_id:null});
const call:Call=async <T,>(path:string)=>{
  if(path.includes('/assets/foreign'))return {...image('foreign','Foreign image'),project_id:'other'} as T;
  if(path.includes('/assets/older'))return image('older','Older image') as T;
  if(path.includes('cursor='))await new Promise(resolve=>setTimeout(resolve,3000));
  return {items:path.includes('cursor=')?[image('older','Older image')]:[image('newer','Newer image')],nextCursor:path.includes('cursor=')?null:'older-page'} as T;
};
createRoot(document.getElementById('root')!).render(<KeyframeStudio workspace={{id:'fixture',name:'Fixture',role:'creator'}} project={{id:'fixture',name:'Fixture'}} user={{id:'fixture'} as never} catalogue={[]} workers={[]} call={call} authorized canEdit localEnabled onChanged={()=>{}}/>);
