# Replace character from the approved still

The video step after the still is approved. The approved still is the first frame, the clip's own
skeleton is the motion, and each person is painted back over the clean clip through their own
mask, so the wall, the microphone and the light stay the clip's pixels. Built on Wan 2.2 Animate 2
(distilled int8), SDPose whole body and SAM 3.1, all already installed for
`native-workflows/local-jutsu-replace`.

## Bindings

- Clean clip: `LoadVideo.file` (node 1), required.
- Approved still: `LoadImage.image` (node `anchor`), required. It is the reference frame, resized to
  832×624 and given to `WanAnimate2ToVideo.reference_image`.
- Scene words: `PrimitiveStringMultiline.value` (node `605`). The compiler writes a base sentence and
  appends the control's text.
- Motion words: `PrimitiveStringMultiline.value` (node `604`), same rule.
- Output: `SaveVideo` (node 246), one video at the clip's own size: 81 frames, 3.4 s at 24 fps.

There is one window. A longer clip is not handled: the relay's second window is broken in this
ComfyUI build (see `docs/LOCAL-JUTSU.md`), so this pack asks for the first 81 frames.

## What the graph does

1. **Mask.** `SAM3_VideoTrack` (`person`, 0.35, 4 objects) and two `SAM3_TrackToMask` nodes: object
   `0` is the man on the right, object `1` the man on the left. `0,1` is their union, which is what
   the composite uses.
2. **Pose, one person at a time.** SDPose draws **one** person per pass. Each person is isolated on a
   black canvas through their own mask, SDPose reads that, and the two drawn skeletons are put back
   on one black canvas. This is the part that has not been run yet (see Qualification).
3. **Animate.** `WanAnimate2ToVideo` takes the still as `reference_image` and the two-person
   skeleton as `pose_video`: 81 frames, 10 steps, shift 5, lcm, cfg 1, fixed seed.
4. **Composite.** `ImageCompositeMasked(destination = clip frames, source = render,
   mask = union person mask)`, then `CreateVideo` at the clip's rate.

The still is not the edit target here: nothing is inpainted frame by frame. The render supplies the
people and the clip supplies everything else, so the scene cannot drift and no overlay pixel can be
invented.

## Compiling

`src/capabilities/from-still.ts` exports `compileFromStill(bundle, invocation, {frames})`. It sets
one window length on the render, the mask slice, the source slice, the black canvas and the render
crop (rounded to 4n+1, never past 81), writes the scene and motion words, and checks the reviewed
wiring before it writes anything: two different masks on one person track, one pose pass per person,
both skeletons on one canvas, the composite over the clip's own frames, exactly one `SaveVideo`.

## Qualification 2026-10-27

One real render of this shape ran on the user's clip (`ec4ec0de…`, 1206×904, 24 fps, cropped) with
the approved still (`ras/qwen-hybrid-final_00001_.png`, rescaled to the clip's size) as the
reference: **437 s, 23.1 GB peak**, 81 frames out. The identities in that render are the still's:
both faces, the racing shirt, the cap, the strap and the watch. The wall, microphone and light are
the clip's own pixels.

That render used **one** pose pass, and it shows two defects that the shipped graph changes but has
not yet been run against:

- SDPose draws one person, so the right man keeps the still's pose instead of following the clip.
- The left man's head is missing from the render (`docs/evidence/replace-from-still/route-a.png`).

So: the anchor→video wiring, the composite and the cost are qualified; the two-person pose pass is
not. The honest next run is one submission of this template on the same clip, and the three routes
the task asked for (SCAIL-2 with the still as reference, Wan VACE first frame + pose) were not run
at all: the local ComfyUI's HTTP server stopped answering after that render and never came back.
Full log: `docs/REPLACE-ANCHOR-EXPERIMENTS.md`; step-2 section: `docs/REPLACE-ANCHOR.md`.

## Not in this pack

- **The two optional pictures.** The task lists optional `character_image` / `character_image_2`.
  They are not declared: the approved still already carries both identities, and an input that
  changes nothing must not be shown. If the director wants them for the panel, the still pack
  (`replace-anchor-still`) already takes them.
- **Overlay removal.** The pack takes a clean clip. The clip on this machine still has the play
  button, avatar, heart/comment column and caption burned in; the app's overlay pass covers only the
  icon column and came back `incomplete` for this clip. Routes that composite therefore inherit
  those pixels, which is what the experiment's delogo stand-in plate worked around.
- **One person.** The graph masks two people; a clip with one person is untested.
