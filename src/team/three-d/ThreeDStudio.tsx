import type {ReactNode} from "react";
import {Box,Image,Paintbrush,Shapes,Sparkles,Workflow} from "lucide-react";
import {Meta,ModelTile,Page,TileGrid,WorkspaceBar} from "../../ds";

import {WorkflowInfoButton} from "../workflow-info";
import type {ThreeDNavigation} from "../navigation";
import type {ThreeDTool} from "./tools";
import {ThreeDWorkflowsPanel} from "./ThreeDWorkflowsPanel";

const icons={viewer:Box,image:Image,text:Sparkles,texture:Paintbrush,mesh:Shapes,workflows:Workflow};
export function ThreeDStudio({tool,navigation,status,children}:{tool:ThreeDTool|"overview";navigation:ThreeDNavigation;status?:ReactNode;children?:ReactNode}) {
  const {tools,tabs}=navigation;
  const overview=tool==="overview";
  return <div className="cf-three-d">
    <WorkspaceBar tabs={{label:"3D workspace",value:tool,items:tabs,onChange:id=>{const tab=tabs.find(item=>item.id===id);if(tab)location.hash=tab.href;}}} density={overview} end={status}
      info={tools.some(item=>item.id==="workflows")?<WorkflowInfoButton title="3D"><Meta>Image to 3D uses the native ComfyField panel. Text to 3D creates an image reference first. Textures applies an image to existing UVs; Mesh tools transforms static GLB files. These tools do not generate UVs, retopologize or rig meshes. Typical time on a fast graphics card: Hunyuan3D 2.1 about 1 minute, grey model; Trellis 2 about 11 minutes, textured, and it removes the background itself. Opening a tool never starts a job or downloads models.</Meta></WorkflowInfoButton>:undefined}/>
    {overview?<Page>
      <TileGrid label="3D tools">{tools.map(item=>{const Icon=icons[item.id];return <ModelTile key={item.id} icon={<Icon size={22}/>} title={item.title} text={item.text} onClick={()=>{location.hash=item.href;}}/>;})}</TileGrid>
    </Page>:tool==="workflows"?<ThreeDWorkflowsPanel/>:children}
  </div>;
}
