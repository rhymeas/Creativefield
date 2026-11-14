# SAM 3.1 image segment

Text-prompted segmentation for the image editor's **Select subject**. You name a part of the
picture ("face", "hair", "jacket", "sleeve"), SAM 3.1 finds it, and the white-on-black mask
comes back as an editor selection that you can add to, subtract from or intersect with.

## Bindings

- Image: `LoadImage.image` (node 1), required. The editor sends the visible picture.
- What to select: `CLIPTextEncode.text` (node 3). SAM 3 accepts short noun phrases; separate
  several with commas.
- Detection threshold: `SAM3_Detect.threshold` (node 4), default 0.35. Lower finds more objects.
- Output: `SaveImage` (node 6), a mask PNG of the source size (union of all detections).

## Model

`models/checkpoints/sam3.1_multiplex_fp16.safetensors`, 1,745,546,848 bytes,
SHA-256 `9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03`, from
`https://huggingface.co/Comfy-Org/sam3.1`. Downloaded on 2026-10-19 at the owner's request.
The weights are under Meta's SAM license; review it before distributing or using them commercially.

## Probe 2026-10-19

Direct run against ComfyUI 0.37.0 / RTX 4090 with a 1920x1072 photo: "hair", "face" and
"jacket" each returned a 1920x1072 mask (7.4 s cold, then 2.0 s and 1.0 s). At threshold 0.5
only the most confident object passed, so the pack defaults to 0.35. This shows the graph runs
and the masks land on the named parts; it does not prove accuracy on every kind of image.
