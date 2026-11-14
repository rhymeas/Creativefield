/** All three images are encoded intact: scene, left character, right character. */
export const SCENE_ANCHOR_ID="replace-scene-anchor";
export const SCENE_ANCHOR_FLUX_ID="replace-scene-anchor-flux";
export type SceneAnchorVariant="qwen"|"flux";
export function sceneAnchorFluxPrompt(request=""){
  return sceneAnchorPrompt(request);
}
export function sceneAnchorPrompt(request=""):string{
  return [
    "Edit the first image, which is a frame from a video. Preserve its camera, composition, background, props, lighting and the exact body, hand and head poses of both people unless the user asks to change them.",
    "Replace only the person on the left with the character shown in the second image. Copy that character's facial features, hair, moustache or beard, clothing and accessories faithfully. If the reference is a portrait and full-body sheet, use both views of the same character.",
    "Replace only the person on the right with the character shown in the third image. Copy that character's facial features, hair, clothing and accessories faithfully. Keep each reference assigned to its own person.",
    "Remove all social media interface overlays, avatar circles, buttons, play icons, hearts, counters, captions, subtitles and watermarks. Reconstruct the scene or clothing behind them. The final image is a clean photographic scene, with no interface or text.",
    request.trim()?`Additional requested changes: ${request.trim()}`:"",
  ].filter(Boolean).join(" ");
}

export type SceneAnchorReview={
  variant:SceneAnchorVariant;
  runId:string;state:"working"|"failed"|"ready"|"approved"|"rejected";
  sourceVideoId:string;sourceFrameId:string;referenceIds:string[];
  candidateId?:string;contextDigest?:string;error?:string;
};
