import { useMemo,useState,type ReactNode } from "react";
import { RefreshCw,Sparkles } from "lucide-react";
import { DensityControl,EmptyState,IconButton,Notice,Page,SearchField,SectionHeader,SegmentedTabs,Toolbar } from "../ds";
import { visibleCapabilities } from "../capabilities/catalogue";
import { CatalogueSections } from "./CatalogueSections";
import type { CapabilityManifestV2,ReadinessState,Requirement } from "../capabilities/types";
import { describeReadiness,type Readiness } from "../workflow/readiness";

export type CatalogueStatus={state:Readiness["state"]|ReadinessState;reasons?:string[];missing?:Requirement[];missingNodes?:string[];missingFiles?:Array<{folder:string;file:string}>;invalidValues?:Readiness["invalidValues"]};
export type CatalogueControls={view:"models"|"nodes";query:string;/** Empties the one search field, so an empty result can undo itself (rule 26). */onClearQuery?:()=>void};
const requirementLabel:Record<Requirement["kind"],string>={node:"Node",model:"Model",software:"Software",credential:"Credential"};
export const requirementKindLabel=(kind:Requirement["kind"])=>requirementLabel[kind];
export function statusReasons(status:CatalogueStatus|undefined):string[]{
  if(!status)return ["Requirements have not been checked."];
  if(status.reasons?.length)return status.reasons;
  const legacy=describeReadiness({state:status.state as Readiness["state"],missingNodes:status.missingNodes??[],missingFiles:status.missingFiles??[],invalidValues:status.invalidValues??[]});
  return legacy.length?legacy:status.state==="offline"?["Start or connect the selected ComfyUI worker, then recheck requirements."]:[];
}
/* The list is the one the team server sends (GET /api/v1/workspaces/:id/catalogue), so the browser
   never adds a pack of its own. This only searches and filters what arrived. */
export function filterCatalogue(items:CapabilityManifestV2[],query:string,coverage="all") {
  const needle=query.trim().toLowerCase();
  return items.filter(m=>(coverage!=="supported"||m.coverage.local==="implemented")&&(!needle||`${m.title} ${m.description} ${m.tickets.join(" ")}`.toLowerCase().includes(needle)));
}
export function CapabilityCatalogue({manifests,statuses,checking,onRecheck,recheckLabel="Recheck requirements",onChoose,onLibrary,library,embedded=false}:{manifests?:CapabilityManifestV2[];statuses:Record<string,CatalogueStatus>;checking:boolean;onRecheck:()=>void;recheckLabel?:string;onChoose:(id:string)=>void;onLibrary:()=>void;library?:ReactNode|((controls:CatalogueControls)=>ReactNode);embedded?:boolean}) {
  const [query,setQuery]=useState(""),[coverage,setCoverage]=useState("all");
  const [view,setView]=useState<"models"|"nodes"|"workflows">(library?"models":"workflows");
  const [libraryQuery,setLibraryQuery]=useState("");
  const workflows=view==="workflows";
  const items=useMemo(()=>filterCatalogue(visibleCapabilities(manifests??[]),query,coverage),[manifests,query,coverage]);
  const available=items.filter(m=>m.coverage.local==="implemented"&&statuses[m.id]?.state==="ready");
  const unavailable=items.filter(m=>!available.includes(m));
  const search=workflows
    ? <SearchField label="Search capabilities" placeholder="Search workflows" value={query} onChange={setQuery}/>
    : <SearchField label={view==="nodes"?"Search installed nodes":"Search installed models"} placeholder={view==="nodes"?"Search nodes":"Search models or folders"} value={libraryQuery} onChange={setLibraryQuery}/>;
  const filters=<div className="cf-catalogue__filters">
    <SegmentedTabs quiet large label="Implementation status" value={coverage} onChange={setCoverage} items={[{id:"all",label:"All"},{id:"supported",label:"Supported"}]}/>
  </div>;
  const libraryNode=typeof library==="function"?library({view:view==="nodes"?"nodes":"models",query:libraryQuery,onClearQuery:()=>setLibraryQuery("")}):library;
  const recheck=workflows&&<IconButton label={checking?"Checking ComfyUI":recheckLabel} disabled={checking} onClick={onRecheck}><RefreshCw size={14}/></IconButton>;
  const actions=<>{recheck}<DensityControl /></>;
  const modalActions=<>{recheck}{search}<DensityControl /></>;
  return <main className={`ds-catalogue${embedded?" ds-catalogue--modal":""}`} aria-label="Models"><Page>
    {!embedded&&<SectionHeader large title="Models" end={actions}/>}
    <Toolbar end={embedded?modalActions:undefined}>
      {library&&<SegmentedTabs quiet large label="Models view" value={view} onChange={setView} items={[{id:"models",label:"Models"},{id:"nodes",label:"Nodes"},{id:"workflows",label:"Workflows"}]}/>}
      {workflows&&filters}
      {!embedded&&search}
    </Toolbar>
    {!workflows&&libraryNode}
    {workflows&&<>
      {!manifests?.length&&<EmptyState icon={<Sparkles size={18}/>} title="Loading workflows" text="Reading the workflow list from the team server."/>}
      {!!manifests?.length&&!items.length&&<EmptyState icon={<Sparkles size={18}/>} title="No workflows match" text="Change the status or search text."/>}
      {!!unavailable.length&&!available.length&&<Notice tone="info" title="Setup required">Open a workflow to review its requirements and available model downloads.</Notice>}
      <CatalogueSections items={items} statuses={statuses} checking={checking} onChoose={onChoose} onLibrary={onLibrary}/>
    </>}
  </Page></main>;
}
