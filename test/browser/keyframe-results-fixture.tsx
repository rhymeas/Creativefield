import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StoryboardResults} from '../../src/team/StoryboardResults';
import type {Call,User,Workspace} from '../../src/team/api';
import '../../src/ds/tokens.css';
import '../../src/ds/components.css';

function Fixture(){
 const [version,setVersion]=useState(0);
 const rows=[{id:'old',state:'succeeded',created_at:'2026-01-01T00:00:00Z'},{id:'new',state:'succeeded',created_at:'2026-01-02T00:00:00Z'}];
 const list=version?[...rows].reverse():[rows[0]];
 const call=(async(url:string)=>url.endsWith('/renders')?list:{...list.find(r=>url.endsWith(r.id)),created_by:'user',project_id:'project',revision:1,output_asset_id:url.endsWith('new')?'new-output':'old-output',shots:[]}) as Call;
 return <><button onClick={()=>setVersion(v=>v+1)}>Simulate new render</button><StoryboardResults key={`board:${version}`} boardId="board" boardRevision={1} workspace={{id:'fixture',role:'creator'} as Workspace} user={{id:'user'} as User} call={call} authorized canEdit version={version}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
