# OpenJutsu advanced swap candidate

`upstream.api.json` is the unmodified API graph from
[D3voz/openjutsu](https://github.com/D3voz/openjutsu/blob/7fe118bb5a61fcfac0148e1bfea3dd29884dbf26/workflows/advanced.api.json),
revision `7fe118bb5a61fcfac0148e1bfea3dd29884dbf26` (MIT). The upstream
project's [`lib/advanced.ts`](https://github.com/D3voz/openjutsu/blob/7fe118bb5a61fcfac0148e1bfea3dd29884dbf26/lib/advanced.ts)
defines the reference-branch removal and role defaults adapted in
`src/capabilities/openjutsu-advanced.ts`.

The app offers this as the multiple-character H3 workflow. One local 480p,
2.33-second test replaced two people using the installed NVFP4 text encoder,
FP16 video VAE and DMAD 4-step LoRA; longer clips and other scenes still need
verification. The template uses Qwen3-VL 8B to describe pictures and identify roles,
SAM 3.1 for people tracking, MiniMax H3 and its LoRA, and the upstream custom
node packs. Models are acquired separately and are not included here.

The graph accepts source video at node `14.video`, four uploaded reference
images at nodes `2.image`, `5.image`, `8.image`, and `11.image`, and role text,
duration, resolution and seed at node `20.roles`, `20.clip_seconds`,
`20.resolution`, and `20.seed`. `prepareOpenJutsuAdvancedCharacters` takes
one to four contiguous worker-uploaded filenames, removes unused loader,
resize and describer nodes and the corresponding plan/reference connections,
and writes the role list. It does not bind or validate the video, configure
other controls, check model readiness or submit the run. The app accepts
optional `@Image N` mentions followed by the person each reference replaces.
