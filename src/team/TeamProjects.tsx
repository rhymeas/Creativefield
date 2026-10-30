import {useState} from "react";
import {FolderOpen,Plus} from "lucide-react";
import {Button,Dialog,EmptyState,ItemList,ListItem,SectionHeader,StatusText,TextField} from "../ds";
import type {Project} from "./api";

export function ProjectCreateDialog({open,onClose,onCreate}:{open:boolean;onClose:()=>void;onCreate:(name:string,description:string)=>Promise<boolean>}){
  const [name,setName]=useState(""),[description,setDescription]=useState(""),[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){e.preventDefault();if(!name.trim()||busy)return;setBusy(true);const ok=await onCreate(name.trim(),description.trim());setBusy(false);if(ok){setName("");setDescription("");onClose();}}
  return <Dialog open={open} title="Add project" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()||busy} onClick={e=>void submit(e as unknown as React.FormEvent)}><Plus size={14}/>Add project</Button></>}>
    <form className="cf-form" onSubmit={submit}>
      <TextField label="Project name" autoFocus required maxLength={120} value={name} onChange={setName} disabled={busy}/>
      <TextField label="Description" maxLength={500} value={description} onChange={setDescription} disabled={busy} hint="Optional · a short purpose shared with the team"/>
    </form>
  </Dialog>;
}

export function TeamProjects({projects,projectId,canCreate,onOpen,onCreate}:{projects:Project[];projectId:string;canCreate:boolean;onOpen:(id:string)=>void;onCreate:(name:string,description:string)=>Promise<boolean>}){
  const [creating,setCreating]=useState(false);
  const create=canCreate?<Button variant="primary" onClick={()=>setCreating(true)}><Plus size={14}/>New project</Button>:undefined;
  return <>
    <SectionHeader large title="Projects" end={projects.length>0?create:undefined}/>
    {projects.length?<ItemList label="Projects">{projects.map(p=><ListItem key={p.id} icon={<FolderOpen size={16}/>} title={p.name} text={p.description} status={p.id===projectId?<StatusText tone="ok">Current</StatusText>:undefined} selected={p.id===projectId} onClick={()=>onOpen(p.id)}/>)}</ItemList>
      :<EmptyState stage icon={<FolderOpen size={18}/>} title="No projects yet" text={canCreate?"A project holds the runs, media and storyboards your team shares.":"Ask an admin or creator to add a project."} action={create}/>}
    <ProjectCreateDialog open={creating} onClose={()=>setCreating(false)} onCreate={onCreate}/>
  </>;
}
