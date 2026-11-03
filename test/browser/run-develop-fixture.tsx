import {createRoot} from "react-dom/client";
import {RunDevelop} from "../../src/team/RunDevelop";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
const run={id:"demo",project_id:"p",created_by:"u",capability_id:"demo",capability_version:"1",state:"running",error:null,output_ids:[],created_at:new Date(Date.now()-75000).toISOString(),updated_at:new Date().toISOString()};
createRoot(document.getElementById("root")!).render(<div style={{width:360,height:280}}><RunDevelop workspaceId="w" run={run} onCancel={()=>{}}/></div>);
