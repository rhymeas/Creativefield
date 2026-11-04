import {useState,type DragEvent} from "react";
import {ASSET_DRAG,CommandBar,Thumb} from "../../ds";
import {contextualIntent,intentLabel,type IntentOverride,type IntentTarget} from "./router";
import "./intent-dock.css";

const actions: Record<Exclude<IntentTarget,"unknown">,string> = {
  image: "Generate image",
  "image-edit": "Open Image Edit",
  video: "Open Create Video",
  motion: "Open Motion Control",
  edit: "Open Edit Area",
  trim: "Open Trim Video",
  storyboard: "Open Storyboard",
  audio: "Open Audio",
};

export function IntentDock({
  value,
  onChange,
  onSubmit,
  available,
  busy,
  reference,
  referenceError,
  onReferenceFile,
  onReferenceAsset,
  onRemoveReference,
  imageWorkspace,
  videoWorkspace,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (target: Exclude<IntentTarget, "unknown">) => void;
  available: Record<Exclude<IntentTarget, "unknown">, boolean>;
  busy?: boolean;
  reference?: {src:string;name:string};
  referenceError?: string;
  onReferenceFile?: (file:File)=>void;
  onReferenceAsset?: (id:string)=>void;
  onRemoveReference?: ()=>void;
  imageWorkspace?: boolean;
  videoWorkspace?: boolean;
}) {
  const [override, setOverride] = useState<IntentOverride>("auto");
  const target = contextualIntent(value,override,!!reference,!!imageWorkspace,!!videoWorkspace);
  const known = target !== "unknown";
  const ready = known && available[target];
  const blocked = known && !available[target];
  const drop=(event:DragEvent)=>{const id=event.dataTransfer.getData(ASSET_DRAG);const file=event.dataTransfer.files[0];if(!id&&!file)return;event.preventDefault();event.stopPropagation();if(id)onReferenceAsset?.(id);else if(file)onReferenceFile?.(file);};
  return <div onDragOver={event=>{if(event.dataTransfer.types.includes(ASSET_DRAG)||event.dataTransfer.types.includes("Files"))event.preventDefault();}} onDrop={drop}>
  {reference&&<div className="cf-intent-reference"><Thumb src={reference.src} label={reference.name} onRemove={onRemoveReference}/></div>}
  <CommandBar
    label="Describe the result"
    placeholder="Describe the scene you imagine"
    value={value}
    onChange={onChange}
    busy={busy}
    mode={{value: override, onChange: setOverride, items: [{id: "auto", label: "Auto"}, {id: "image", label: "Image"}, {id: "video", label: "Video"}]}}
    submitLabel={ready ? reference&&target==="image"?"Open Image with reference":reference&&target==="video"?"Open Video with reference":actions[target as Exclude<IntentTarget,"unknown">] : "Describe what you want first"}
    submitDisabled={!ready}
    onSubmit={ready ? () => onSubmit(target as Exclude<IntentTarget,"unknown">) : undefined}
    hint={referenceError||(blocked ? `No ready local workflow for ${intentLabel(target)}.` : undefined)}
  />
  </div>;
}
