import type {ReactNode} from "react";
import {Box,Image,Paintbrush,Shapes,Sparkles,Workflow} from "lucide-react";
import {Meta,ModelTile,Page,TileGrid,WorkspaceBar} from "../../ds";

import {WorkflowInfoButton} from "../workflow-info";
import {NATIVE_THREE_D_TOOLS,type ThreeDTool} from "./tools";
import {ThreeDWorkflowsPanel} from "./ThreeDWorkflowsPanel";

const icons={viewer:Box,image:Image,text:Sparkles,texture:Paintbrush,mesh:Shapes,workflows:Workflow};
export function ThreeDStudio({tool,tools,status,children}:{tool:ThreeDTool|"overview";tools:readonly ThreeDTool[];status?:ReactNode;children?:ReactNode}) {
  const available=NATIVE_THREE_D_TOOLS.filter(item=>tools.includes(item.id));
  const tabs=[{id:"overview",label:"Overview"},...available.map(item=>({id:item.id,label:item.id==="workflows"?"Workflows":item.title}))];
  const overview=tool==="overview";
  return <div className="cf-three-d">
    <WorkspaceBar tabs={{label:"3D workspace",value:tool,items:tabs,onChange:id=>{location.hash=id==="overview"?"3d":`3d/${id}`;}}} density={overview} end={status}
      info={tools.includes("workflows")?<WorkflowInfoButton title="3D"><Meta>Image to 3D uses the native ComfyField panel. Text to 3D creates an image reference first. Textures applies an image to existing UVs; Mesh tools transforms static GLB files. These tools do not generate UVs, retopologize or rig meshes. Typical time on a fast graphics card: Hunyuan3D 2.1 about 1 minute, grey model; Trellis 2 about 11 minutes, textured, and it removes the background itself. Opening a tool never starts a job or downloads models.</Meta></WorkflowInfoButton>:undefined}/>
    {overview?<Page>
      <TileGrid label="3D tools">{available.map(item=>{const Icon=icons[item.id];return <ModelTile key={item.id} icon={<Icon size={22}/>} title={item.title} text={item.text} onClick={()=>{location.hash=`3d/${item.id}`;}}/>;})}</TileGrid>
    </Page>:tool==="workflows"?<ThreeDWorkflowsPanel/>:children}
  </div>;
}
