/** Editable starting points; they do not choose a clip, mask or model. */
export const MASK_EDIT_IDEAS = [
  { value: "background", label: "Replace background", prompt: "Replace the selected background with a sunlit green forest. Match its lighting and perspective to the foreground subject. Keep the protected subject and its movement unchanged." },
  { value: "recolor", label: "Recolor", prompt: "Change the selected area to blue, preserving its shape, texture and movement. Keep everything outside the selected area unchanged." },
  { value: "material", label: "Change material", prompt: "Make the selected area look like brushed metal, matching the scene’s lighting and movement. Keep everything outside the selected area unchanged." },
  { value: "remove", label: "Remove object", prompt: "Remove the object in the selected area and fill it with a natural continuation of the background. Preserve the camera movement and everything outside the selected area." },
] as const;
