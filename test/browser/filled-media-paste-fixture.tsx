import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TeamMediaInput} from '../../src/team/TeamMediaInput';
import type {Asset} from '../../src/team/api';
import '../../src/ds/tokens.css';import '../../src/ds/components.css';import '../../src/team/team.css';
const selected:Asset={id:'one',project_id:'p',name:'one.png',media_type:'image',content_type:'image/png',bytes:'1',created_at:'2026-01-01',parent_id:null};
function Fixture(){const [file,setFile]=useState<File|null>(null);return <main style={{width:320,padding:20}}><TeamMediaInput label="Reference" type="image" workspace="w" projectId="p" selected={selected} options={[selected]} file={null} disabled={false} canUpload onFile={setFile} onSelect={()=>{}} onUpload={()=>{}}/><output>{file?`${file.name}:${file.type}`:'empty'}</output><textarea aria-label="Prompt"/></main>}
createRoot(document.getElementById('root')!).render(<Fixture/>);
