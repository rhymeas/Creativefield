import {WorkflowDescription} from "./workflow-info";
import {useEffect,useRef,useState} from 'react';
import {Block,Button,Collapsible,ConfirmDialog,Dialog,EmptyState,GenerateButton,LinkButton,Meta,ModelCard,Notice,Page,Panel,PromptField,Row,Split,TextField,Toolbar} from '../ds';
import {routerModelsFor,type CloudFeature,type RouterModel} from '../capabilities/router-models';
import {TeamMediaInput} from './TeamMediaInput';
import {TeamRuns} from './TeamLibrary';
import {ApiError,composerAssets,workspacePath,type Asset,type Call,type Project,type Run,type User,type Workspace} from './api';

type Intent={projectId:string;idempotencyKey:string;capabilityId:string;version:string;routeId:string;inputs:Record<string,string>;controls:Record<string,string|number|boolean>;audioPolicy:'mute'|'replace';consent:{cloudCredits:true}};
type Draft={model:string;inputs:Record<string,string>;controls:Record<string,string|number|boolean>;pending?:Intent};
const defaults=(m:RouterModel)=>Object.fromEntries(m.controls.map(c=>[c.id,c.default as string|number|boolean]));
const labels:Record<CloudFeature,string>={'image-create':'Create image','image-edit':'Edit image','image-angles':'Angles','image-relight':'Relight','video-create':'Create video','video-edit':'Edit video','replace-character':'Replace character','motion-transfer':'Motion transfer',restyle:'Restyle','object-swap':'Object swap',openjutsu:'OpenJutsu · H3 API',unsupported:'Cloud rendering'};
const changeFeatures:CloudFeature[]=['replace-character','motion-transfer','object-swap','restyle'];
function restored(key:string,models:RouterModel[],incoming?:{inputs:Record<string,string>;prompt:string}):Draft{
 let draft:Draft|undefined;try{const d=JSON.parse(localStorage.getItem(key)??'null') as Draft;if(d&&models.some(m=>m.id===d.model)&&d.inputs&&d.controls)draft=d;}catch{}
 const m=models.find(m=>m.id===draft?.model)??models[0];draft??={model:m?.id??'',inputs:{},controls:m?defaults(m):{}};
 if(incoming&&!draft.pending&&m){draft.inputs={...draft.inputs,...Object.fromEntries(m.inputs.filter(p=>incoming.inputs[p.id]).map(p=>[p.id,incoming.inputs[p.id]]))};if(incoming.prompt)draft.controls={...draft.controls,prompt:incoming.prompt};}
 return draft;
}
/** Shared by creative surfaces. Media stays in the same project; only execution changes. */
export function CloudRenderStudio({feature,workspace,project,user,call,version,canEdit,onQueued,onSettings,onLocal,onFeature,incoming}:{feature:CloudFeature;workspace:Workspace;project:Project;user:User;call:Call;version:number;canEdit:boolean;onQueued:()=>void;onSettings:()=>void;onLocal:()=>void;onFeature?:(f:CloudFeature)=>void;incoming?:{inputs:Record<string,string>;prompt:string}}){
 const models=routerModelsFor(feature),key=`comfyfield.router.v1:${user.id}:${workspace.id}:${project.id}:${feature}`;
 const [draft,setDraft]=useState<Draft>(()=>restored(key,models,incoming)),[assets,setAssets]=useState<Asset[]>([]),[connected,setConnected]=useState<boolean|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[confirm,setConfirm]=useState(false),[advanced,setAdvanced]=useState(false),[secret,setSecret]=useState(''),[connectError,setConnectError]=useState('');
 const model=models.find(m=>m.id===draft.model)??models[0],locked=!!busy||!!draft.pending;
 const queueGate=useRef(false);
 const inputKey=Object.values(draft.inputs).filter(Boolean).join(',');
 useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(draft));}catch{}},[key,draft]);
 useEffect(()=>{let active=true;void Promise.all([call<{connected:boolean}>(workspacePath(workspace.id,'router-models')),composerAssets(call,workspace.id,project.id,inputKey.split(',').filter(Boolean))]).then(([state,media])=>{if(active){setConnected(state.connected);setAssets(media.items);}}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[call,workspace.id,project.id,version,inputKey]);
 if(!models.length)return <Page narrow><EmptyState title="No compatible BYOK cloud model" text="CreativeField has no reviewed Comfy Router contract for this tool yet. Use this computer, or connect a Comfy Cloud worker in settings. Choosing a target never starts a render." action={<><Button variant="secondary" onClick={onLocal}>Use this computer</Button><Button variant="ghost" onClick={onSettings}>Cloud settings</Button></>}/></Page>;
 async function connect(){const key=secret.trim();if(!/^comfyui-\S+$/.test(key)){setConnectError('A Comfy workspace API key starts with comfyui-. Copy it from platform.comfy.org.');return;}setConnectError('');setBusy('key');setError('');try{await call(workspacePath(workspace.id,'provider-connections'),'POST',{providerId:'comfy-router',secret:secret.trim()});setSecret('');setConnected(true);onQueued();}catch(e){setConnectError((e as Error).message);}finally{setBusy('');}}
 async function upload(role:string,file:File){
  // Say at once, in this panel, why a file is not taken, instead of failing quietly.
  const video=model?.inputs.find(p=>p.id===role)?.type==='video',okType=video?['video/mp4','video/quicktime'].includes(file.type)||/\.(mp4|mov)$/i.test(file.name):['image/png','image/jpeg'].includes(file.type)||/\.(png|jpe?g)$/i.test(file.name);
  if(!okType){setError(video?'This model takes MP4 or MOV videos. Convert the file first, or choose one from the library.':'This model takes PNG or JPEG pictures. Convert the file first, or choose one from the library.');return;}
  if(video&&file.size>100*1024*1024){setError('The video is larger than 100 MB. Trim or compress it first.');return;}
  setBusy(role);setError('');try{const form=new FormData();form.append('file',file);const a=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),'POST',form);setAssets(old=>[a,...old]);setDraft(d=>({...d,inputs:{...d.inputs,[role]:a.id}}));}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 async function queue(){
  if(!model||queueGate.current)return;queueGate.current=true;setConfirm(false);setBusy('render');setError('');
  const intent=draft.pending??{projectId:project.id,idempotencyKey:crypto.randomUUID(),capabilityId:model.id,version:'1.0.0',routeId:'router',inputs:Object.fromEntries(model.inputs.filter(p=>draft.inputs[p.id]).map(p=>[p.id,draft.inputs[p.id]])),controls:draft.controls,audioPolicy:model.kind==='h3-reference'?'replace' as const:'mute' as const,consent:{cloudCredits:true as const}};
  // Save before HTTP so an ambiguous acknowledgement cannot mint a second paid request.
  setDraft(d=>({...d,pending:intent}));try{localStorage.setItem(key,JSON.stringify({...draft,pending:intent}));}catch{}
  try{await call<Run>(workspacePath(workspace.id,'runs'),'POST',intent);setDraft(d=>({...d,pending:undefined}));onQueued();}catch(e){if(e instanceof ApiError&&[400,401,403,404,422].includes(e.status)){setDraft(d=>({...d,pending:undefined}));setError((e as Error).message);}else setError(`${(e as Error).message} Retry submission keeps the same request ID to avoid a duplicate render.`);}finally{queueGate.current=false;setBusy('');}
 }
 const missing=model?.inputs.some(p=>p.required&&!draft.inputs[p.id]),invalid=model?.controls.some(c=>{const v=draft.controls[c.id];return c.type==='string'?!String(v??'').trim():c.type==='select'?!c.options?.includes(v as string|number):typeof v!=='number'||!Number.isFinite(v)||c.min!==undefined&&v<c.min||c.max!==undefined&&v>c.max;});
 const titles=Object.fromEntries(models.map(m=>[m.id,`${m.title} · Comfy Router`]));
 return <Page><WorkflowDescription title={model?.title??labels[feature]}><Meta>Comfy Router cloud rendering uses your connected Comfy workspace credits. A cost estimate is unavailable; check the provider price before rendering.</Meta>{model?.kind==='h3-reference'&&<Meta>Experimental H3 reference-to-video API, not the original OpenJutsu swap workflow. Scene, motion, identity and overlay cleanup are not qualified. H3 may generate audio; the original soundtrack is not guaranteed. A saved scene still can be an extra reference.</Meta>}<LinkButton href="https://platform.comfy.org" target="_blank" rel="noopener noreferrer">Comfy models and billing</LinkButton></WorkflowDescription><Split><Panel footer={model?<GenerateButton busy={busy==='render'} label={draft.pending?'Retry submission':'Generate in cloud'} disabled={!canEdit||!!busy||!connected||!!missing||!!invalid} disabledReason={!connected?'Connect Comfy Router first':missing?'Add the required media':invalid?'Complete the prompt and settings':undefined} onClick={()=>draft.pending?void queue():setConfirm(true)}/>:undefined}>
  <div className="cf-form">
   <ModelCard title={labels[feature]} subtitle={model?model.title:"Comfy Router"}/>
   {error&&<Notice inline title="Cloud request failed" actions={<Button variant="secondary" onClick={()=>setError('')}>Dismiss</Button>}>{error}</Notice>}
   {connected===false&&<Collapsible title="Comfy API key" arrow="end">
    <Meta>Connect your Comfy workspace API key. Models use that workspace’s credits; connecting does not start a render.</Meta>
    {workspace.role==='admin'?<><TextField label="Comfy API key" type="password" autoComplete="new-password" value={secret} onChange={v=>{setSecret(v);setConnectError('');}}/><Toolbar><Button variant="primary" disabled={!!busy||!secret.trim()} onClick={()=>void connect()}>{busy==='key'?'Connecting…':'Connect Comfy Router'}</Button><LinkButton href="https://platform.comfy.org/profile/api-keys" target="_blank" rel="noopener noreferrer">Get a key</LinkButton></Toolbar>{connectError&&<Notice inline title="Could not connect">{connectError}</Notice>}</>:<Meta>Ask a workspace admin to connect Comfy Router in Providers / keys.</Meta>}
   </Collapsible>}
   {model&&<>
    {changeFeatures.includes(feature)&&onFeature&&<Row label="Change" display={labels[feature]} value={feature} disabled={locked} onChange={id=>onFeature(id as CloudFeature)} options={changeFeatures.map(f=>({value:f,label:labels[f]}))}/>}
    {model.inputs.map(p=><TeamMediaInput key={p.id} workspace={workspace.id} label={p.label} type={p.type} accept={p.type==='video'?'video/mp4,video/quicktime':'image/png,image/jpeg'} hint={p.type==='video'?(model.kind==='h3-reference'?'Pre-trimmed MP4 or MOV · 2–15 seconds · 24–60 fps · 256 px minimum · 100 MB':'MP4 or MOV · 3–10 seconds · 720p–2160p · 24–60 fps'):(model.kind==='h3-reference'?'PNG or JPEG · 256 px minimum · 10 MB combined':'PNG or JPEG · 10 MB combined references')} file={null} selected={assets.find(a=>a.id===draft.inputs[p.id])} options={assets.filter(a=>a.media_type===p.type&&(p.type==='image'?['image/png','image/jpeg'].includes(a.content_type):['video/mp4','video/quicktime'].includes(a.content_type)))} uploading={busy===p.id?'Uploading…':undefined} disabled={!canEdit||locked} canUpload={canEdit} onFile={file=>{if(file)void upload(p.id,file);}} onSelect={id=>setDraft(d=>({...d,inputs:{...d.inputs,[p.id]:id}}))} onUpload={()=>{}}/>)}
    <PromptField label="Prompt" placeholder="Describe the result you want" value={String(draft.controls.prompt??'')} disabled={locked||!canEdit} onChange={prompt=>setDraft(d=>({...d,controls:{...d.controls,prompt}}))}/>
    <Row label="Model" display={model.title} value={model.id} disabled={locked} onChange={id=>{const next=models.find(m=>m.id===id);if(next)setDraft(d=>({model:next.id,inputs:d.inputs,controls:defaults(next)}));}} options={models.map(m=>({value:m.id,label:m.title}))}/>
    <Button variant="secondary" onClick={()=>setAdvanced(true)}>Advanced settings</Button>
    <Dialog open={advanced} title="Advanced" onClose={()=>setAdvanced(false)} footer={<Button variant="primary" onClick={()=>setAdvanced(false)}>Done</Button>}>
    {model.controls.filter(c=>c.id!=='prompt').map(c=>c.type==='select'?<Row key={c.id} label={c.label} display={String(draft.controls[c.id])} value={String(draft.controls[c.id])} disabled={locked} options={c.options!.map(v=>({value:String(v),label:String(v)}))} onChange={v=>setDraft(d=>({...d,controls:{...d.controls,[c.id]:v}}))}/>:<TextField key={c.id} label={c.label} type="number" min={c.min} max={c.max} value={String(draft.controls[c.id]??'')} disabled={locked} onChange={v=>setDraft(d=>({...d,controls:{...d.controls,[c.id]:Number(v)}}))}/>)}
    </Dialog>
    <Toolbar>    {connected&&workspace.role==='admin'&&<Button variant="ghost" onClick={onSettings}>Manage keys</Button>}</Toolbar>
   </>}
   {!model&&<EmptyState title="No compatible cloud model connected for this tool" text="This tool has no verified Comfy Router integration yet. Your local workflow remains available." action={<Button variant="secondary" onClick={onLocal}>Use this computer</Button>}/>}
  </div>
 </Panel><Block><TeamRuns examples="video" workspace={workspace} project={project} user={user} call={call} canEdit={canEdit} authorized version={version} titles={titles} capabilityId={models.map(m=>m.id)}/></Block></Split>
 <ConfirmDialog open={confirm} title={`Render with ${model?.title??'Comfy Router'}?`} text="This sends the selected media to Comfy Router and its model provider, and spends your Comfy workspace credits. The cost estimate is unavailable. Only continue if you accept the current provider price." confirmLabel="Use credits and render" onCancel={()=>setConfirm(false)} onConfirm={()=>void queue()}/>
 </Page>;
}
