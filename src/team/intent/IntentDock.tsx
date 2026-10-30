import {useState} from "react";
import {CommandBar} from "../../ds";
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
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (target: Exclude<IntentTarget, "unknown">) => void;
  available: Record<Exclude<IntentTarget, "unknown">, boolean>;
  busy?: boolean;
}) {
  const [override, setOverride] = useState<IntentOverride>("auto");
  const target = classifyIntent(value, override);
  const known = target !== "unknown";
  const ready = known && available[target];
  const blocked = known && !available[target];
  return <CommandBar
    label="Describe the result"
    placeholder="Describe the scene you imagine"
    value={value}
    onChange={onChange}
    busy={busy}
    mode={{value: override, onChange: setOverride, items: [{id: "auto", label: "Auto"}, {id: "image", label: "Image"}, {id: "video", label: "Video"}]}}
    submitLabel={ready ? actions[target as Exclude<IntentTarget,"unknown">] : "Describe what you want first"}
    submitDisabled={!ready}
    onSubmit={ready ? () => onSubmit(target as Exclude<IntentTarget,"unknown">) : undefined}
    hint={blocked ? `No ready local workflow for ${intentLabel(target)}.` : undefined}
  />;
}
