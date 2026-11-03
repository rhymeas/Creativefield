import {useState,type DragEvent} from "react";
import {ASSET_DRAG,CommandBar,IconButton} from "../../ds";
import {classifyIntent,intentLabel,type IntentOverride,type IntentTarget} from "./router";

const actions: Record<Exclude<IntentTarget,"unknown">,string> = {
  image: "Generate image",
  video: "Open Create Video",
  motion: "Open Motion Control",
  edit: "Open Edit Video",
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
}) {
  const [override, setOverride] = useState<IntentOverride>("auto");
  const classified = classifyIntent(value, override);
  // An image alone cannot satisfy a video-edit workflow; in Auto mode, edit
  // instructions accompanying it open image editing instead.
  const target = reference && override==="auto" && classified==="edit" ? "image" : classified;
  const known = target !== "unknown";
  const ready = known && available[target];
  const blocked = known && !available[target];
  const drop=(event:DragEvent)=>{const id=event.dataTransfer.getData(ASSET_DRAG);const file=event.dataTransfer.files[0];if(!id&&!file)return;event.preventDefault();event.stopPropagation();if(id)onReferenceAsset?.(id);else if(file)onReferenceFile?.(file);};
  return <div onDragOver={event=>{if(event.dataTransfer.types.includes(ASSET_DRAG)||event.dataTransfer.types.includes("Files"))event.preventDefault();}} onDrop={drop}>
  {reference&&<div className="ds-intent-reference"><img src={reference.src} alt={reference.name}/><IconButton label="Remove reference" onClick={onRemoveReference}>×</IconButton></div>}
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
