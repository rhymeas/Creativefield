import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StoryboardShotEditor} from '../../src/team/StoryboardShotEditor';
import {newShot} from '../../src/team/storyboard-state';
import type {Asset} from '../../src/team/api';
import type {CapabilityManifestV2} from '../../src/capabilities/types';
import h3 from '../../native-workflows/h3-flf2v/manifest.json';
import '../../src/ds/tokens.css';
import '../../src/ds/components.css';
import '../../src/team/team.css';

const model=h3 as unknown as CapabilityManifestV2;
const asset=(id:string):Asset=>({id,project_id:'p',name:`${id}.png`,media_type:'image',content_type:'image/png',bytes:'1',created_at:'2026-01-01',parent_id:null});
const assets=[asset('one'),asset('two')];
function Fixture(){
 const [shot,setShot]=useState(()=>({...newShot(model),prompt:'Move the person',assets:[{role:'start_image',assetId:'one'},{role:'end_image',assetId:'two'}]}));
 return <main style={{width:360,padding:16}}><StoryboardShotEditor shot={shot} manifests={[model]} assets={assets} elements={[]} workspace="w" projectId="p" disabled={false} files={{}} onChange={setShot} onFile={()=>{}} onUpload={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
