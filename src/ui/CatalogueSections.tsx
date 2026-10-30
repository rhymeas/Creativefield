import { useState, type ReactNode } from "react";
import { Clapperboard, Download, Image, LayoutGrid, Maximize2, Move, Music2, Replace, Sparkles, User, Video } from "lucide-react";
import { Button, CodeLine, Collapsible, Dialog, LinkButton, Meta, ModelTile, Notice, SectionHeader, StatusText, TileGrid } from "../ds";
import type { CapabilityManifestV2, Requirement } from "../capabilities/types";
import { capabilityPurpose, capabilitySurface, surfaceLabel, surfaceOrder, type CapabilitySurface } from "../capabilities/surfaces";
import { describeReadiness, type Readiness } from "../workflow/readiness";
import {modelDownloadUrl,modelDownloadSize} from "../capabilities/model-download";
import "./catalogue.css";

export type CatalogueStatus = { state: Readiness["state"] | string; reasons?: string[]; missing?: Requirement[]; missingNodes?: string[]; missingFiles?: Array<{ folder: string; file: string }>; invalidValues?: Readiness["invalidValues"] };
const requirementLabel: Record<Requirement["kind"], string> = { node: "Node", model: "Model", software: "Software", credential: "Credential" };
const requirementKindLabel = (kind: Requirement["kind"]) => requirementLabel[kind];
const statusReasons = (status: CatalogueStatus | undefined): string[] => {
  if (!status) return ["Requirements have not been checked."];
  if (status.reasons?.length) return status.reasons;
  const legacy = describeReadiness({ state: status.state as Readiness["state"], missingNodes: status.missingNodes ?? [], missingFiles: status.missingFiles ?? [], invalidValues: status.invalidValues ?? [] });
  return legacy.length ? legacy : status.state === "offline" ? ["Start or connect the selected ComfyUI worker, then recheck requirements."] : [];
};

const surfaceIcon: Record<CapabilitySurface, ReactNode> = {
  image: <Image size={16} />,
  "video-create": <Video size={16} />,
  "video-edit": <Video size={16} />,
  "video-enhance": <Maximize2 size={16} />,
  "video-effect": <Sparkles size={16} />,
  motion: <Move size={16} />,
  audio: <Music2 size={16} />,
  replacement: <Replace size={16} />,
  identity: <User size={16} />,
  studios: <Clapperboard size={16} />,
  canvas: <LayoutGrid size={16} />,
  other: <Sparkles size={16} />
};

const readinessLabel = (status: CatalogueStatus | undefined, checking: boolean) => {
  if (checking) return "Checking";
  if (status?.state === "missing_models" || status?.state === "download_required") return "Model required";
  if (status?.state === "install_required") return "Installation required";
  if (status?.state === "credentials_required") return "Credential required";
  if (status?.state === "incompatible") return "Requirements unverified";
  if (status?.state === "offline") return "Offline";
  return "Qualification required";
};

/** What an unready workflow still needs, in plain words: the first missing item, then how many follow. */
export function missingText(status: CatalogueStatus | undefined): string | undefined {
  const missing = status?.missing ?? [];
  if (!missing.length) return undefined;
  const [first] = missing;
  const more = missing.length - 1;
  return `Needs ${first.kind} ${first.name}${more ? ` and ${more} more` : ""}`;
}

/** Where a workflow belongs in the gallery: it runs now, or it needs setup first. */
export function catalogueView(m: CapabilityManifestV2, status: CatalogueStatus | undefined, checking: boolean): "ready" | "setup" {
  return m.coverage.local === "implemented" && status?.state === "ready" && !checking ? "ready" : "setup";
}

function bySurface(items: CapabilityManifestV2[]) {
  return surfaceOrder.map(surface => ({ surface, items: items.filter(item => capabilitySurface(item) === surface) })).filter(group => group.items.length > 0);
}

function exportManifest(manifest: CapabilityManifestV2) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `comfyfield-${manifest.id}-${manifest.version}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CatalogueSections({
  items,
  statuses,
  checking,
  onChoose,
  onLibrary
}: {
  items: CapabilityManifestV2[];
  statuses: Record<string, CatalogueStatus>;
  checking: boolean;
  onChoose: (id: string) => void;
  onLibrary: () => void;
}) {
  const [open, setOpen] = useState<CapabilityManifestV2 | null>(null);
  const status = open ? statuses[open.id] : undefined;
  const ready = !!open && catalogueView(open, status, checking) === "ready";
  const missingIds=new Set(status?.missing?.map(r=>r.id));
  const order=(r:Requirement)=>r.kind==="model"?(missingIds.has(r.id)?0:1):2;
  const requirements=[...(open?.routes[0].requirements??[])].sort((a,b)=>order(a)-order(b));
  return <>
    {bySurface(items).map(group => <section className="cf-catalogue__section" key={group.surface}>
      <SectionHeader title={surfaceLabel(group.surface)} meta={<Meta parts={[`${group.items.length}`]} />} />
      <TileGrid label={`${surfaceLabel(group.surface)} workflows`}>{group.items.map(m => {
        const state = catalogueView(m, statuses[m.id], checking);
        /* An unready row says what it still needs, so the gallery answers "why not this one". */
        return <ModelTile key={m.id} roomy dim={state !== "ready"} icon={surfaceIcon[group.surface]} title={m.title.split(" (")[0]} text={(state !== "ready" && missingText(statuses[m.id])) || capabilityPurpose(m)}
          status={state === "ready" ? <StatusText tone="ok">Ready</StatusText> : <StatusText tone="warn">{readinessLabel(statuses[m.id], checking)}</StatusText>} onClick={() => setOpen(m)} />;
      })}</TileGrid>
    </section>)}
    <Dialog open={!!open} title={open?.title.split(" (")[0] ?? ""} onClose={() => setOpen(null)}
      footer={open && <>
        <Button variant="ghost" onClick={() => exportManifest(open)}><Download size={12} />Export manifest</Button>
        {ready && (open.category === "enhance" ? <Button variant="primary" onClick={() => { setOpen(null); onLibrary(); }}>Choose a video</Button> : <Button variant="primary" onClick={() => { const id = open.id; setOpen(null); onChoose(id); }}>Open workflow</Button>)}
      </>}>
      {open && <>
        <Meta parts={[open.description]} />
        {!ready && <Notice tone="info" title={readinessLabel(status, checking)}>{statusReasons(status).join(" ")}</Notice>}
        <Collapsible title="Installation requirements" open={!ready || undefined}>
          {open.routes[0].requirements.some(r=>modelDownloadUrl(r))&&<Meta>Downloads open the official model host. Save each file in the listed ComfyUI models folder, then recheck requirements. Files are not installed automatically.</Meta>}
          {requirements.length ? requirements.map(r => {
            const download=modelDownloadUrl(r);
            const installed=status?.state==="ready"||(status?.state==="download_required"&&!status.missing?.some(item=>item.id===r.id));
            return <div className="ds-detaillist" key={r.id}>
              <Meta parts={[requirementKindLabel(r.kind),modelDownloadSize(r.bytes),r.version]} />
              <CodeLine>{r.location ? `${r.location}/${r.name}` : r.name}</CodeLine>
              <Meta>{r.instructions}</Meta>
              {download&&!installed&&<LinkButton variant="secondary" href={download} target="_blank" rel="noopener noreferrer" aria-label={`Download ${r.name}`}>Download</LinkButton>}
            </div>;
          }) : <Meta>None</Meta>}
        </Collapsible>
        <Collapsible title="Software and model licenses"><p>{open.licenses.software}</p>{open.licenses.weights.map(w => <p key={w.name}>{w.name}: {w.license}</p>)}</Collapsible>
        <Meta parts={[...open.tickets, `Version ${open.version}`]} />
      </>}
    </Dialog>
  </>;
}
