import {useState} from "react";
import {createRoot} from "react-dom/client";
import {TeamMediaInput} from "../../src/team/TeamMediaInput";
import {ExampleTiles} from "../../src/team/ExampleTiles";
import "../../src/ds/tokens.css";
import "../../src/ds/components.css";
import "../../src/team/team.css";
function App(){const [file,setFile]=useState<File|null>(null);return <><TeamMediaInput label="Source video" type="video" accept="video/mp4" file={file} selected={undefined} options={[]} disabled={false} canUpload workspace="w" onFile={setFile} onSelect={()=>{}} onUpload={()=>{}}/><output>{file?`${file.name} · ${file.type} · ${file.size}`:"No file"}</output><ExampleTiles kind="video" count={1}/></>;}
createRoot(document.getElementById("root")!).render(<App/>);
