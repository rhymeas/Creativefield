/** All three images are encoded intact: scene, left character, right character. */
export const SCENE_ANCHOR_ID="replace-scene-anchor";
export const SCENE_ANCHOR_FLUX_ID="replace-scene-anchor-flux";
export type SceneAnchorVariant="qwen"|"flux";
export function sceneAnchorFluxPrompt(request=""){
  return "Edit the FIRST picture. Keep the exact pose, position, size, head direction, arm and hand gestures of BOTH people from the FIRST picture. Change only their identity, hair and clothes. The LEFT person becomes the person in the SECOND picture; use the portrait and full-body view together for face and complete outfit. The RIGHT person becomes the person in the THIRD picture; faithfully retain his beard, cap, grey top, brown shoulder strap and watch. Preserve each reference person's facial proportions, cheek fullness, apparent age, beard colour and texture, and hair length. Do not beautify, de-age, slim the face, darken the beard, invent longer hair or substitute a similar-looking person. The other pictures supply appearance, never pose. Keep the orange wall, microphone, lighting and camera. Remove the central play triangle, social-media avatar, buttons, hearts, counters and subtitles. Reconstruct the scene or clothes behind these overlays, leaving no interface residue."+(request.trim()?` ${request.trim()}`:"");
}
export function sceneAnchorPrompt(request=""):string{
  return [
    "Edit the first image, which is a frame from a video. Preserve its camera, composition, background, microphone, lighting and the exact body, hand and head poses of both people.",
    "Replace only the person on the left with the character shown in the second image. Copy that character's facial features, hair, moustache or beard, clothing and accessories faithfully. If the reference is a portrait and full-body sheet, use both views of the same character.",
    "Replace only the person on the right with the character shown in the third image. Copy that character's facial features, beard or moustache, cap, clothing and accessories, including any shoulder strap. Keep each reference assigned to its own person.",
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
