import {useEffect,useState,type ReactNode} from "react";
import {Box,Image,Paintbrush,Shapes,Sparkles,Workflow} from "lucide-react";
import {Button,EmptyState,Meta,ModelTile,Page,TileGrid,WorkspaceBar} from "../../ds";
import type {Worker,Workspace} from "../api";

import {WorkflowInfoButton} from "../workflow-info";
import {NATIVE_THREE_D_TOOLS,threeDTool} from "./tools";
import {ThreeDWorkflowsPanel} from "./ThreeDWorkflowsPanel";

const icons={viewer:Box,image:Image,text:Sparkles,texture:Paintbrush,mesh:Shapes,workflows:Workflow};
export function ThreeDStudio({canEdit,status,imagePanel,textPanel,texturePanel,meshPanel,viewerPanel,workflowsPanel}:{textPanel?:ReactNode;texturePanel?:ReactNode;meshPanel?:ReactNode;viewerPanel?:ReactNode;imagePanel?:ReactNode;workflowsPanel?:ReactNode;workspace:Workspace;workers:Worker[];canEdit:boolean;status?:ReactNode}) {
  const [tool,setTool]=useState(()=>threeDTool(location.hash.split("/")[1]));
  useEffect(()=>{const update=()=>setTool(threeDTool(location.hash.split("/")[1]));addEventListener("hashchange",update);return()=>removeEventListener("hashchange",update);},[]);
  const available=NATIVE_THREE_D_TOOLS;
  const tabs=[{id:"overview",label:"Overview"},...available.map(item=>({id:item.id,label:item.id==="workflows"?"Workflows":item.title}))];
  const value=tool??"overview";
  const projectMissing=<Page narrow><EmptyState title="Choose a project" text="Open a project to use Library assets in this tool." action={<Button variant="secondary" onClick={()=>{location.hash="projects";}}>Projects</Button>}/></Page>;
  return <div className="cf-three-d">
    <WorkspaceBar tabs={{label:"3D workspace",value,items:tabs,onChange:id=>{location.hash=id==="overview"?"3d":`3d/${id}`;}}} density={!tool} end={status} info={<WorkflowInfoButton title="3D"><Meta>Image to 3D uses the native ComfyField panel. Text to 3D creates an image reference first. Textures applies an image to existing UVs; Mesh tools transforms static GLB files. These tools do not generate UVs, retopologize or rig meshes. Typical time on a fast graphics card: Hunyuan3D 2.1 about 1 minute, grey model; Trellis 2 about 11 minutes, textured, and it removes the background itself. Opening a tool never starts a job or downloads models.</Meta></WorkflowInfoButton>}/>
    {!canEdit?<Page narrow><EmptyState title="3D tools require creator access" text="Ask your workspace administrator for creator access to open the local editor."/></Page>:location.hash.split("/")[1]&&!tool?<Page narrow><EmptyState title="This 3D page does not exist" text="Choose an available tool from the 3D workspace." action={<Button variant="secondary" onClick={()=>{location.hash="3d";}}>3D overview</Button>}/></Page>:tool==="image"?(imagePanel??<Page narrow><EmptyState title="Choose a project" text="Open a project to use the Image to 3D panel." action={<Button variant="secondary" onClick={()=>{location.hash="projects";}}>Projects</Button>}/></Page>):tool==="workflows"?(workflowsPanel??<ThreeDWorkflowsPanel/>):tool==="text"?(textPanel??projectMissing):tool==="texture"?(texturePanel??projectMissing):tool==="mesh"?(meshPanel??projectMissing):tool==="viewer"?(viewerPanel??projectMissing):tool?<Page narrow><EmptyState title="No native workflow for this tool" text="This tool has no runnable ComfyField contract yet. Choose an available 3D workflow, or open Nodes to work with templates." action={<><Button variant="secondary" onClick={()=>{location.hash="3d/image";}}>Image to 3D</Button><Button variant="ghost" onClick={()=>{location.hash="nodes";}}>Open Nodes</Button></>}/></Page>:<Page>
      <TileGrid label="3D tools">{available.map(item=>{const Icon=icons[item.id];return <ModelTile key={item.id} icon={<Icon size={22}/>} title={item.title} text={item.text} onClick={()=>{location.hash=`3d/${item.id}`;}}/>;})}</TileGrid>
    </Page>}
  </div>;
}
