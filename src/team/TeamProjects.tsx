import {useCallback,useEffect,useState} from "react";
import {FolderOpen,Plus} from "lucide-react";
import {Button,Dialog,EmptyState,ItemList,ListItem,SectionHeader,StatusText,TextField,Working} from "../ds";
import type {Project} from "./api";

/** Keep a browser preference only when the current workspace list confirms it. */
export function useProjectSelection(userId:string,workspaceId:string){
  const key=`comfyfield.project:v1:${userId}:${workspaceId}`;
  const [projects,setProjects]=useState<Project[]|null>(null);
  const [projectId,setProjectId]=useState(()=>{
    try{return localStorage.getItem(key)??"";}catch{return "";}
  });
  const project=projects?.find(item=>item.id===projectId);
  useEffect(()=>{
    if(project)try{localStorage.setItem(key,project.id);}catch{/* Browsing still works without storage. */}
  },[key,project?.id]);
  const replaceProjects=useCallback((next:Project[])=>{
    setProjects(next);
    setProjectId(id=>next.some(item=>item.id===id)?id:next[0]?.id??"");
  },[]);
  function addProject(item:Project){
    setProjects(current=>[item,...(current??[]).filter(project=>project.id!==item.id)]);
    setProjectId(item.id);
  }
  return {projects:projects??[],projectsLoading:projects===null,project,projectId,setProjectId,replaceProjects,addProject};
}

export function ProjectCreateDialog({open,onClose,onCreate}:{open:boolean;onClose:()=>void;onCreate:(name:string,description:string)=>Promise<boolean>}){
  const [name,setName]=useState(""),[description,setDescription]=useState(""),[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){e.preventDefault();if(!name.trim()||busy)return;setBusy(true);const ok=await onCreate(name.trim(),description.trim());setBusy(false);if(ok){setName("");setDescription("");onClose();}}
  return <Dialog open={open} title="Add project" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()||busy} onClick={e=>void submit(e as unknown as React.FormEvent)}><Plus size={14}/>Add project</Button></>}>
    <form className="cf-form" onSubmit={submit}>
      <div className="cf-project-create__name"><TextField label="Project name" autoFocus required maxLength={120} value={name} onChange={setName} disabled={busy}/></div>
      <TextField label="Description" maxLength={500} value={description} onChange={setDescription} disabled={busy} hint="Optional · a short purpose shared with the team"/>
    </form>
  </Dialog>;
}

export function TeamProjects({projects,projectId,loading,canCreate,onOpen,onCreate}:{projects:Project[];projectId:string;loading:boolean;canCreate:boolean;onOpen:(id:string)=>void;onCreate:(name:string,description:string)=>Promise<boolean>}){
  const [creating,setCreating]=useState(false);
  if(loading)return <><SectionHeader large title="Projects"/><Working label="Loading projects"/></>;
  const create=canCreate?<Button variant="primary" onClick={()=>setCreating(true)}><Plus size={14}/>New project</Button>:undefined;
  return <>
    <SectionHeader large title="Projects" end={projects.length>0?create:undefined}/>
    {projects.length?<ItemList label="Projects">{projects.map(p=><ListItem key={p.id} icon={<FolderOpen size={16}/>} title={p.name} text={p.description} status={p.id===projectId?<StatusText tone="ok">Current</StatusText>:undefined} selected={p.id===projectId} onClick={()=>onOpen(p.id)}/>)}</ItemList>
      :<EmptyState stage icon={<FolderOpen size={18}/>} title="No projects yet" text={canCreate?"A project holds the runs, media and storyboards your team shares.":"Ask an admin or creator to add a project."} action={create}/>}
    <ProjectCreateDialog open={creating} onClose={()=>setCreating(false)} onCreate={onCreate}/>
  </>;
}
