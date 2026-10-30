# Manual-mask VACE editing — qualified local route

Independent local ComfyUI graph with a dedicated source-linked mask editor. The qualified route accepts a manually prepared aligned mask, submits to local ComfyUI and publishes only an output that passes timing, geometry and mute validation. This is not tracking, proprietary internals, reference-based identity replacement, or evidence of general output quality.

## Inputs and bindings

- Source: ordinary camera footage up to 128 MiB. If it is not already the strict VACE envelope, the server derives a 16 FPS, timestamp-zero, 17–81 frame (4n+1) version, fitting it to dimensions divisible by 16, at most 832 per side and 399360 pixels, with black padding; the first ~5.06 s are used.
- Mask: same geometry as the source and covering its duration; grayscale, white edits / black preserves, no audio. It is normalized to the same 16 FPS timing as the source. Upload through the source-linked mask-sequence endpoint. Generic video uploads are not masks.
- The normalized source derivative and mask are stored as project assets; the response carries `maskNormalization` back to the original source. Output is 16 FPS at the normalized geometry.
- Prompt → node 10; negative → 11; seed → 17; conditioning strength → 15. Dimensions, frame count and FPS come from the source. Mute only.

Source + mask → black-fill masked conditioning region (the official VACE inpainting template's preprocessing) → WanVaceToVideo → 20-step UniPC → VAE decode → composite generated pixels over the original using the same mask → save video. No reference image is connected, so no reference-latent trimming is needed. Soft masks blend; lossy encoding can alter pixels outside the edit region. No bit-exact preservation claim.

The 1.3B diffusion model is pinned to Comfy-Org revision `123acf1cc74bccbb9bfff8ac1ee72edc08c2341d`; 4309519800 bytes; SHA-256 `640ccc0577e6a5d4bb15cd91b11b699ef914fc55f126c5a1c544e152130784f2`. Downloaded weights and declared licenses are not proof of output quality or complete open-source qualification. Shared encoder/VAE licensing remains part of release review.

Preflight decodes timestamps and mask pixels with bounded FFprobe/FFmpeg processes. It records source/mask hashes; execution rehashes disk inputs before worker upload. Output dimensions/timing/mute policy are checked before artifact publication. These checks do not sandbox arbitrary native decoders or untrusted ComfyUI nodes.


## Tracked masks and decoded-pixel limit (21 October 2026)

A separate SAM3.1 mask with a verified creator review was used in actual run
2ea3e620-fa27-4eb0-a40e-48be96808ad1. Tracking is not performed inside this VACE
graph. The graph composites black mask areas from the source before SaveVideo;
the encoded export is not pixel-identical outside the mask. On this 17-frame
fixture, 341853/2420858 black-mask pixels exceeded a maximum-channel RGB8 delta
of2 (14.12%); mean maximum-channel delta1.63, maximum112. These measurements
are not a semantic quality score and do not isolate every source of pixel change.
Do not advertise this temporal route as pixel-exact preservation. See the S36
continuation evidence for occlusion review and manual correction.
