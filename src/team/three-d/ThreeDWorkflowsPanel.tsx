import {Shapes} from "lucide-react";
import {ModelTile,Page,SectionHeader,TileGrid} from "../../ds";

const workflows=[
  {id:"trellis2-image-to-3d",title:"TRELLIS.2 image to 3D",text:"Create a textured GLB from a Library image."},
  {id:"hunyuan3d-21",title:"Hunyuan3D 2.1 image to 3D",text:"Create an untextured GLB mesh from a Library image."},
] as const;

/** A chooser for the shipped 3D contracts. It never aliases the Image-to-3D composer. */
export function ThreeDWorkflowsPanel(){
  return <Page>
    <SectionHeader large title="3D workflows"/>
    <TileGrid label="Installed 3D workflows">{workflows.map(workflow=><ModelTile key={workflow.id} icon={<Shapes size={22}/>} title={workflow.title} text={workflow.text} onClick={()=>{location.hash=`3d/image/${workflow.id}`;}}/>)}</TileGrid>
  </Page>;
}
