# Static ad compositor v1

This recipe is a server-local, deterministic-layout raster compositor. It is not a ComfyUI graph and does not call a model or hosted API.

It decodes one authorized product raster (and an optional workspace-shared logo), lays it out with fixed format-safe regions, converts copy from the bundled Space Grotesk font to vector outlines, and emits a verified PNG. Three layouts are selected from the stable zero-based variant index. The compositor supports PNG, JPEG, and WebP source images, a maximum of 25 MiB and 30 million decoded pixels per source, and at most six variants per render request.

The renderer rejects copy that cannot wrap at the documented minimum sizes and rejects glyphs missing from the bundled Latin font. If the approved text color does not meet WCAG 4.5:1 against the background, it records and uses whichever of black or white has the higher passing contrast. Deterministic bytes are verified for repeated renders on the installed pinned renderer build; identical bytes across different native `sharp`/libvips platforms are not claimed.

This recipe does not generate copy or imagery, render video, publish campaigns, or provide a freeform canvas.
