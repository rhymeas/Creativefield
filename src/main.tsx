import { StrictMode,lazy,Suspense } from "react";
import { createRoot } from "react-dom/client";
import Showcase from "./ds/Showcase";
import {rootViewFromHash} from "./team/route-state";
import "./ds/base.css";
import "./ds/components.css";
const TeamApp=lazy(()=>import("./team/TeamApp"));
const NodeGraphDesign=lazy(()=>import("./team/nodes/NodeGraphDesign").then(m=>({default:m.NodeGraphDesign})));
// One app: the full studio is the only entry. #ds opens the design system showcase.
function Root() {
  if(location.hash === "#ds")return <Showcase />;
  if(location.hash === "#nodedesign")return <div style={{height:"100vh",padding:16,boxSizing:"border-box",display:"flex",flexDirection:"column"}}><Suspense fallback={<p>Opening node editor design…</p>}><NodeGraphDesign/></Suspense></div>;
  return <Suspense fallback={<p>Opening CreativeField…</p>}><TeamApp/></Suspense>;
}

const initialRootView=rootViewFromHash(location.hash);
addEventListener("hashchange", () => {
  if(rootViewFromHash(location.hash)!==initialRootView)location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
