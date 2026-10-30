import {WorkflowDescription} from "./workflow-info";
import {useEffect,useRef,useState} from 'react';
import {Block,Button,CodeLine,ConfirmDialog,DataRow,GenerateButton,LinkButton,Meta,Notice,Page,Panel,PromptField,Split} from '../ds';
import {TeamMediaInput} from './TeamMediaInput';
import {TeamRuns} from './TeamLibrary';
import {ApiError,composerAssets,workspacePath,type Asset,type Call,type Project,type User,type Workspace} from './api';

type Account={connected:boolean;pending?:boolean;busy?:boolean;email?:string;plan?:string;verificationUrl?:string;userCode?:string};
const path=(workspace:string,tail:string)=>workspacePath(workspace,`chatgpt-image/${tail}`);
export function ChatgptImageAccount({workspace,call,onState}:{workspace:Workspace;call:Call;onState?:(account:Account)=>void}){
 const [account,setAccount]=useState<Account|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[disconnect,setDisconnect]=useState(false);
 async function load(){const state=await call<Account>(path(workspace.id,'account'));setAccount(state);onState?.(state);}
 useEffect(()=>{let active=true;void call<Account>(path(workspace.id,'account')).then(state=>{if(active){setAccount(state);onState?.(state);}}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[workspace.id,call]);
 async function action(tail?:string){setBusy(true);setError('');try{if(tail){const state=await call<Account>(path(workspace.id,tail),'POST');if(tail==='login'){setAccount(state);onState?.({...state,connected:false});return;}}await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <>
  {error&&<Notice priority={60} title="ChatGPT connection failed" actions={<Button variant="secondary" onClick={()=>void action()}>Check again</Button>}>{error}</Notice>}
  <DataRow title="ChatGPT" meta={<Meta>{account?.connected?[account.email,account.plan].filter(Boolean).join(' · ')||'Signed in for your CreativeField account':account?.pending?'Complete sign-in in your browser':'Use your own ChatGPT account through the local Codex CLI.'}</Meta>} actions={account?.connected?<Button variant="secondary" disabled={busy} onClick={()=>setDisconnect(true)}>Disconnect ChatGPT</Button>:account?.pending?<Button variant="secondary" disabled={busy} onClick={()=>void action('login/cancel')}>Cancel sign-in</Button>:workspace.role!=='viewer'?<Button variant="primary" disabled={busy||!account} onClick={()=>void action('login')}>Sign in with ChatGPT</Button>:undefined}/>
  {account?.pending&&<><CodeLine>{account.userCode??''}</CodeLine>{account.verificationUrl&&<LinkButton href={account.verificationUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</LinkButton>}<Button variant="secondary" disabled={busy} onClick={()=>void action()}>Check sign-in</Button></>}
  <ConfirmDialog open={disconnect} title="Disconnect ChatGPT?" text="This signs out your CreativeField ChatGPT profile and cancels your active image edit. Other users’ connections stay available." confirmLabel="Disconnect" onCancel={()=>setDisconnect(false)} onConfirm={()=>{setDisconnect(false);void action('logout');}}/>
 </>;
}
type Feature='image-edit'|'image-angles'|'image-relight';
type Intent={projectId:string;idempotencyKey:string;feature:Feature;inputs:Record<string,string>;prompt:string;consent:{subscriptionQuota:true}};
type Draft={inputs:Record<string,string>;prompt:string;pending?:Intent};
const roles=[{id:'source_image',label:'Your image',required:true},{id:'reference_image',label:'Reference image',required:false},{id:'reference_image_2',label:'Second reference',required:false}];
const sharedKey=(key:string)=>key.replace(/:image-(?:edit|angles|relight)$/,':shared');
function restore(key:string,incoming?:{inputs:Record<string,string>;prompt:string}):Draft{let draft:Draft={inputs:{},prompt:''};try{const shared=JSON.parse(localStorage.getItem(sharedKey(key))??'null');if(shared?.inputs)draft.inputs=shared.inputs;const saved=JSON.parse(localStorage.getItem(key)??'null');if(saved&&saved.inputs&&typeof saved.prompt==='string')draft=saved;}catch{}if(incoming&&!draft.pending)draft={inputs:{...draft.inputs,...incoming.inputs},prompt:incoming.prompt||draft.prompt};return draft;}
/** Prompt-based editing only; precise masks, video and deterministic export are not represented as compatible. */
export function ChatgptImageStudio({feature,workspace,project,user,call,version,canEdit,onQueued,incoming}:{feature:Feature;workspace:Workspace;project:Project;user:User;call:Call;version:number;canEdit:boolean;onQueued:()=>void;incoming?:{inputs:Record<string,string>;prompt:string}}){
 const key=`comfyfield.chatgpt-image.v1:${user.id}:${workspace.id}:${project.id}:${feature}`;
 const [draft,setDraft]=useState<Draft>(()=>restore(key,incoming)),[account,setAccount]=useState<Account|null>(null),[assets,setAssets]=useState<Asset[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState(''),[confirm,setConfirm]=useState(false);const gate=useRef(false),selected=Object.values(draft.inputs).filter(Boolean).join(',');
 useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(draft));if(!draft.pending)localStorage.setItem(sharedKey(key),JSON.stringify({inputs:draft.inputs}));}catch{}},[key,draft]);
 useEffect(()=>{let active=true;void composerAssets(call,workspace.id,project.id,selected.split(',').filter(Boolean)).then(r=>{if(active)setAssets(r.items);}).catch(e=>{if(active)setError((e as Error).message);});return()=>{active=false;};},[call,workspace.id,project.id,version,selected]);
 async function upload(role:string,file:File){setBusy(role);setError('');try{const form=new FormData();form.append('file',file);const asset=await call<Asset>(workspacePath(workspace.id,`assets?projectId=${project.id}`),'POST',form);setAssets(old=>[asset,...old]);setDraft(d=>({...d,inputs:{...d.inputs,[role]:asset.id}}));}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 async function queue(){if(gate.current)return;gate.current=true;setBusy('queue');setConfirm(false);setError('');
  const request=draft.pending??{projectId:project.id,idempotencyKey:crypto.randomUUID(),feature,inputs:Object.fromEntries(roles.filter(r=>draft.inputs[r.id]).map(r=>[r.id,draft.inputs[r.id]])),prompt:draft.prompt,consent:{subscriptionQuota:true as const}};
  const pending={...draft,pending:request};setDraft(pending);try{localStorage.setItem(key,JSON.stringify(pending));}catch{}
  try{await call(path(workspace.id,'runs'),'POST',request);setDraft(d=>({...d,pending:undefined}));onQueued();}catch(e){if(e instanceof ApiError&&[400,401,403,404,409,422,429].includes(e.status))setDraft(d=>({...d,pending:undefined}));setError((e as Error).message);}finally{setBusy('');gate.current=false;}
 }
 const locked=!!busy||!!draft.pending,title=feature==='image-angles'?'Angles':feature==='image-relight'?'Relight':'Edit image';
 return <Page><WorkflowDescription title={`${title} · ChatGPT`}><Meta>Uses your ChatGPT quota. Early access; availability depends on your account. Image size may change. Your source stays intact.</Meta></WorkflowDescription><Split><Panel header={<Meta>{title} · ChatGPT</Meta>} footer={account?.connected&&canEdit?<GenerateButton busy={busy==='queue'} label={draft.pending?'Check submission':'Edit with ChatGPT'} disabled={!!busy||!draft.inputs.source_image||!draft.prompt.trim()} disabledReason={!draft.inputs.source_image?'Add your image':!draft.prompt.trim()?'Describe the edit':undefined} onClick={()=>draft.pending?void queue():setConfirm(true)}/>:undefined}><div className="cf-form">
  <ChatgptImageAccount key={`${user.id}:${workspace.id}`} workspace={workspace} call={call} onState={setAccount}/>
  {error&&<Notice priority={60} title="Image edit failed" actions={<Button variant="secondary" onClick={()=>setError('')}>Dismiss</Button>}>{error}</Notice>}
  {roles.map(role=><TeamMediaInput key={role.id} workspace={workspace.id} label={role.label} type="image" accept="image/png,image/jpeg,image/webp" hint={role.required?'PNG, JPEG or WebP · 18 MB combined':'Optional reference'} file={null} selected={assets.find(a=>a.id===draft.inputs[role.id])} options={assets.filter(a=>a.media_type==='image'&&['image/png','image/jpeg','image/webp'].includes(a.content_type))} uploading={busy===role.id?'Uploading…':undefined} disabled={!canEdit||locked} canUpload={canEdit} onFile={file=>{if(file)void upload(role.id,file);}} onSelect={id=>setDraft(d=>({...d,inputs:{...d.inputs,[role.id]:id}}))} onUpload={()=>{}}/>)}
  <PromptField label="Prompt" placeholder={feature==='image-angles'?'Describe the viewpoint and what to preserve':feature==='image-relight'?'Describe the lighting and what to preserve':'Describe what to change and what to preserve'} value={draft.prompt} disabled={!canEdit||locked} onChange={prompt=>setDraft(d=>({...d,prompt}))}/>

 </div></Panel><Block><TeamRuns workspace={workspace} project={project} user={user} call={call} canEdit={canEdit} authorized version={version} titles={{'chatgpt-image-edit':'ChatGPT image edit'}} capabilityId={['chatgpt-image-edit']}/></Block></Split>
 <ConfirmDialog open={confirm} title="Edit with your ChatGPT account?" text="The selected images and prompt are sent to OpenAI through Codex and may use your ChatGPT quota. One background edit runs, with no automatic retry or API-key fallback." confirmLabel="Use quota and edit" onCancel={()=>setConfirm(false)} onConfirm={()=>void queue()}/>
 </Page>;
}
