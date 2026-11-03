# Video export profiles

Status: implemented backend contract with one route, `POST /api/v1/workspaces/:workspaceId/assets/:id/exports`, and a "Download 1080p MP4" action on a finished storyboard film. Requests cannot choose dimensions, frame rate, codec or audio policy; only a profile ID selects the exact contract.

## Route and result

The route takes `{"profileId": "mp4-h264-720p24" | "mp4-h264-1080p24"}`, needs creator access, accepts only a video asset from the same workspace, and reports readiness before it encodes. The encoded file is stored as a new workspace video asset named `<source name> (1080p MP4)` or `(720p MP4)`, with the source asset as its parent and `metadata.export` holding the returned provenance. The action downloads that asset through the normal asset content route. Vertical 9:16 delivery is not offered because no vertical profile exists yet.

## Versioned profiles

`server/export-profiles.ts` defines two immutable version 1 delivery profiles. A declaration change requires a new profile ID or version; callers cannot override the dimensions, frame rate, codec, pixel format or audio policy.

| Profile ID | Resolution | FPS | Container / video | Pixels | Audio |
| --- | ---: | ---: | --- | --- | --- |
| `mp4-h264-720p24` | 1280×720 | fixed 24 | MP4 / H.264 through `libx264` | `yuv420p`, SAR 1:1 | mute |
| `mp4-h264-1080p24` | 1920×1080 | fixed 24 | MP4 / H.264 through `libx264` | `yuv420p`, SAR 1:1 | mute |

Both profiles use the declared `medium` x264 preset and CRF 18. They first apply the source sample-aspect ratio to normalize anamorphic material to square pixels, then fit it inside the target canvas and pad to the exact dimensions. They reset timestamps, remove metadata and encode a constant 24 FPS stream. The expected frame count is the source video duration rounded to the nearest output frame. Input audio is deliberately omitted; this slice does not preserve, replace or mix audio.

## Readiness and execution boundary

Readiness is reported per profile and requires:

- an executable FFmpeg build that lists the `libx264` encoder;
- an executable FFprobe build.

AAC is not checked or required because these profiles always mute. `FFMPEG_PATH` and `FFPROBE_PATH` may point to server-managed binaries. This repository does not bundle either program.

`exportVideo` accepts only an existing workspace-scoped `DiskStore` key, so source lookup uses the existing path and symlink checks. Scratch lives in a private attempt directory under `.exports` in the configured storage root. This keeps export intermediates on configured storage, not the operating-system temp directory. Each encode has a two-minute process timeout, verification has a 30-second timeout, and the whole attempt has a three-minute cancellation/deadline signal. Sources longer than five minutes are rejected. Normal success, validation failure and cancellation remove attempt files; an abrupt process or machine termination can still leave an orphan directory for an operator to remove after confirming no export is active.

Source probing and encoding allow only self-contained MOV/MP4, Matroska/WebM, AVI, MPEG/TS and Ogg demuxers over the local file protocol. Indirect concat, HLS, playlist and image-sequence inputs are rejected before dereferencing so the recorded source hash covers the bytes used by the export.

The candidate is probed before it is copied into durable storage. Acceptance requires exactly one stream, MP4 format, H.264, the profile dimensions, `yuv420p`, square pixels, exact average and real frame rates, exact decoded frame count, timestamp zero, duration consistent with frame count / 24, and no audio/data/subtitle streams. The returned provenance includes the source SHA-256 (but never its private storage key or filesystem path), exact profile object, output hash/size, decoded frames and measured duration. A failed publish is removed if it was created. If scratch cleanup itself fails, a primary encode or verification error remains the reported failure; an otherwise successful export is withdrawn instead of reporting success with leaked scratch.

## Evidence and limits

The source video stream duration takes precedence over container duration.
For Matroska, its stream DURATION tag supplies that value when stream.duration
is absent. A deterministic fixture has twelve 30 fps video frames and a longer
0.8-second audio track; both mute profiles must produce ten 24 fps frames rather
than following the audio tail. Files without stream timing retain the container
duration fallback and are rejected if strict output frame verification disagrees.

`test/export-profiles.test.ts` creates a short video with a PCM audio stream when local FFmpeg and FFprobe are available, runs both profiles, verifies the strict output contract and checks scratch cleanup. The test is skipped when either binary is unavailable. Passing the structural test proves encoding and media-envelope behavior on that installed binary build; it does not establish perceptual quality, platform playback coverage, performance for long clips, or suitability of CRF 18 for every source.

FFmpeg licensing depends on how it was configured. `libx264` is GPL-licensed, and an FFmpeg binary built with it is generally a GPL build. Anyone packaging or distributing binaries must inspect that exact build, preserve the applicable notices and source-offer obligations, and evaluate H.264 patent/licensing requirements for the intended jurisdictions and distribution model. This repository supplies invocation code only and makes no conclusion that a particular binary distribution is cleared for commercial delivery.
