<div align="center">
  <img src="src/assets/creativefield-logo.png" alt="CreativeField" width="360">

  <a href="https://www.creativefield.app/examples/creativefield-promo-v3.mp4"><img src="docs/screens/creativefield/creativefield-promo-v3.webp" alt="Watch the CreativeField introduction video" width="100%"></a>

  [▶ Watch the CreativeField video](https://www.creativefield.app/examples/creativefield-promo-v3.mp4)

  # CreativeField

  **A free, open-source, AI-powered Photoshop alternative, and a simple studio for ComfyUI video, image and 3D. It runs on your own computer.**
</div>

**[Try it online at creativefield.app](https://www.creativefield.app/)** — every browser gets its own private try-out workspace. Your library stays in your browser and FotoField documents never leave it. A file reaches the server only while it is needed: the server drops it a few minutes after your browser holds a checked copy, and it goes back up only when a render needs it. Run records stay on the server until a day without a visit. Sign in with your own Comfy API key and renders run on Comfy Router (FLUX, Seedance, Kling, MiniMax H3) on your Comfy credits, the free plan included. The key is kept in your browser; the server only holds it in memory while it talks to Comfy for you.

Made for the [#OpenSourceHiggsfield](https://comfy.org/open-source-higgsfield/) challenge.

## Why CreativeField

Having a pro-grade palette at your fingertips, and every feature ComfyUI brings with it, does not mean you need a toolbox with all the equipment in it. Most of the time the work comes down to a few core moves: you start from an input and you want a video, a picture, or an edit of a picture. CreativeField is built around exactly those moves.

Along the way we built our own free, open-source, AI-powered alternative to Photoshop. It runs locally, and it works.

**Everything connects.** CreativeField is meant to cover a whole workflow, not a list of separate tools. Make a picture, then edit it. Use it as the reference for a video, or turn it into a 3D model. Use that 3D model as the reference for the next picture or video edit, and keep going. We will keep extending it towards the top ten film-creation tools and the most important photo-editing goals, all working together.

**Nodes you can read.** We are reworking how ComfyUI nodes look, so a graph is clearer and easier to use. A first design preview is in the app; the goal is a short description on every node that tells you what it does.

**Your workflows become apps.** Download a workflow or build your own, and CreativeField turns it into an app in the matching category: Video, Image or 3D.

We are open to ideas. Open an issue and tell us what you would like to see next.

## Models

CreativeField picks one model per job instead of offering a long list. These four carry the app:

| Model | Job in CreativeField |
| --- | --- |
| **MiniMax H3** | All video creation, with sound: from words, from a picture, between a first and last frame. Also character swap (OpenJutsu), object swap, Effect clips and Grey-block to video |
| **FLUX 3 Klein** | Creates images; also camera angles and relight |
| **Fibo 2.0** | Edits images: multi-picture edits, masked edits, Ad Studio and Remix variations |
| **Qwen Image 2.1** | The first choice for AI edits in FotoField; also creates images, turns objects to new angles, and is the fallback for FLUX 3 Klein |

If the first choice for a job is not installed on your computer, the app takes the next one that is ready and says so. Workflow folders named `flux2-klein-*` keep their old names but run FLUX 3 Klein weights.

A few jobs stay with specialised models: SAM 3.1 for masks, SeedVR2 and Z-Image Turbo for upscaling, Hunyuan3D 2.1 and TRELLIS.2 for 3D. New look and Copy moves still run on Wan 2.1 VACE, SCAIL-2 and Wan Animate 2, and Make it talk on Wan 2.1 InfiniteTalk.

![FotoField: layers, selections, masks and AI edits in the browser](docs/screens/creativefield/fotofield-editor.png)

**FotoField**, our image editor, has layers, masks, selections, smart objects, blend modes, crop, transform and brushes, and its AI tools (modify, magic eraser, subject select) run through ComfyUI on your machine. No subscription and no account; nothing leaves your computer unless you choose a cloud route. The rest of CreativeField puts the same idea around video, image and 3D: each tool is a real ComfyUI workflow behind a plain panel, and you can open the graph when you want it.

It is an early preview, not a Photoshop clone. FotoField covers the everyday layered-editing and AI-editing path; it does not yet match Photoshop's depth (see [Current limits](#current-limits)).

## Status

| | |
| --- | --- |
| **Apps** | More than 40 workflow folders in `native-workflows/` plus the official-template pipelines in `pipelines/`, each with a manifest that binds the simple panel to the graph. |
| **Built with ComfyUI** | Every generation runs in your ComfyUI. Cloud routes (Comfy Cloud, Comfy Router) exist but are optional and have not been proven end to end. |
| **Proven on this machine** | Windows 10, RTX 4090, 64 GB RAM: MiniMax H3 video from words, pictures and grey blocks, FLUX 3 Klein images, Fibo 2.0 and Qwen Image 2.1 edits, masked video edits, character replace (experimental), Image to 3D. |
| **Not proven** | macOS and Linux, a clean install on a fresh machine, the cloud routes, output quality on other hardware. |

## Apps

| App | What it does | Models | Status |
| --- | --- | --- | --- |
| **FotoField** | Layered photo editor with AI modify, magic eraser, subject select and masks | Qwen Image 2.1, Fibo 2.0, FLUX 3 Klein, SAM 3.1 | Working; the AI part needs an image-edit workflow installed |
| **Create Video** | Words, a picture, or a first and last frame to video with sound; Effect clips from one photo; Sharpen 2× keeps the same take at twice the size | MiniMax H3 | Working; camera moves are prompt guidance (see below) |
| **Change Video** | Replace character, swap a thing, new look, copy moves, sharpen and upscale | MiniMax H3, SAM 3.1, SeedVR2, Wan 2.1 VACE, SCAIL-2, Wan Animate 2 | Working; replace character is experimental |
| **Image** | Make a picture, edit it, turn an object to new angles, relight | FLUX 3 Klein, Fibo 2.0, Qwen Image 2.1 | Working |
| **3D** | Image to 3D, Text to 3D, viewer, textures, mesh tools | Hunyuan3D 2.1, TRELLIS.2 | Working |
| **Block a shot** | Pick a set and a camera move: a grey layout is drawn, then Grey-block to video turns it into a real shot that keeps the camera path and where everything stands | MiniMax H3; Wan 2.1 VACE depth restyle when H3 is not ready | Working on a GPU; three sets, eight moves |
| **Short film** | Write the shots, make each one, get one video | MiniMax H3 plus FFmpeg assembly | Assembly works; identity can drift between shots |
| **Import a workflow** | Turn a saved ComfyUI workflow file into a simple panel: inputs, controls and result are found for you | the nodes and models installed on your ComfyUI | Working; 7 of 11 saved workflows on our test machine convert, including current Flux 3 Klein, Fibo 2, Z-Image, SeedVR2 and MiniMax H3 templates. API exports and graphs with an unconnected required input are refused |

## Screenshots

| All tools | Create Video |
| --- | --- |
| ![All tools](docs/screens/creativefield/all-tools.png) | ![Create Video workspace](docs/screens/creativefield/create-video-camera.png) |
| **FotoField editor** | **Keyframes workspace** |
| ![FotoField editor](docs/screens/creativefield/fotofield-editor.png) | ![Keyframes workspace](docs/screens/creativefield/keyframes-preview.webp) |
| **3D workspace** | **Nodes editor** |
| ![3D workspace](docs/screens/creativefield/3d.png) | ![Nodes editor with a sample image graph](docs/screens/creativefield/nodes-preview.webp) |
| **Trim video** | **Project library** |
| ![Trim video workspace](docs/screens/creativefield/trim-video.png) | ![Project library](docs/screens/creativefield/library.png) |
| **How it was made** | **Create Image** |
| ![Full view: references, prompt, model and settings beside the result, with Recreate](docs/screens/creativefield/full-view.png) | ![Create Image workspace with project results and examples](docs/screens/creativefield/create-image.png) |

These screenshots show the application in a demo project. They show the interface, not a claim about output quality; the Nodes view shows a sample image graph.

### Camera moves are measured, not assumed

On MiniMax H3 a camera move is a direction in the prompt, not a fixed path: the model follows it, but not by an exact amount. When a shot needs one exact path, use **Block a shot**: H3 keeps the camera path of the grey layout frame for frame. The `wan22-fun-camera` workflow, which takes a fixed path, also stays in `native-workflows/`. `scripts/camera-check.mjs` measures how far any clip really moved, and `scripts/motion-check.mjs` tells a living clip from a still one. `scripts/seam-check.mjs` says whether a clip loops cleanly or jumps at the loop point, judges a cut inside a clip, and can trim a clip to its best closing window; it is a port of the Seam Doctor in [OpenField](https://github.com/wexloops/openfield) and the seam check in [Body Double](https://github.com/lucataco/open-source-higgsfield).

## Run it

**Requirements:** Node.js 22 or newer, a desktop browser at 1280 × 720 or larger, and ComfyUI on the same machine for generation. Models and custom nodes are installed separately and have their own hardware needs and terms.

1. Install [ComfyUI](https://github.com/comfyanonymous/ComfyUI). The Windows portable build works. To start it from here, set `COMFY_HOME` to its folder and run `scripts/start-comfy.bat`.
2. From this folder:

```bash
npm install
npm start
```

3. Open [the local studio](http://127.0.0.1:8787). The first start prepares the app and its database.
4. Open **Models**, pick a workflow and check what it needs. An online worker alone does not mean its models and nodes are installed.
5. Choose a tool in **All tools**, add your inputs and press **Generate**.

FotoField works without any model for everything except the AI buttons. Copy `.env.example` to `.env` to change ports, storage or the cloud key.

## Add an app

Every app is a folder in `native-workflows/` with a ComfyUI graph (`template.api.json`) and a `manifest.json` that says which node fields the panel exposes. We do not rewrite graphs: an app is an official, hub or your own ComfyUI workflow with a simplified front. You can also import a saved workflow in the app; it keeps only the controls it needs inline and leaves the rest under **Advanced**.

## Connections and data

Local generation uses your configured ComfyUI worker. Cloud is optional: select a supported connection and check the model, account access and cost before submitting anything. Cloud runs can send selected inputs to the provider and can consume credits. A ChatGPT subscription should not be assumed to support every image-editing operation.

Keep generated runtime configuration, credentials, account profiles, project data and backups private. Never include them in a source contribution.

## Current limits

- **FotoField is not Photoshop.** It has layers, masks, smart objects, selections, blend modes, crop and transform, but no CMYK, no raw development, no plug-in ecosystem and fewer filters and adjustment layers.
- **Replace character is experimental.** Reference fidelity, multi-person replacement, the still-to-video handoff and overlay cleanup need further visual qualification.
- **Cloud and OpenJutsu need end-to-end qualification.** A visible panel or a compatible protocol does not establish successful generation for your account.
- **3D:** the native Image to 3D panel is integrated; other 3D tools remain editor/template entry points. This UI work did not requalify model outputs.
- **Not yet rehearsed:** a clean install on a fresh machine, and macOS or Linux.

## Development

```bash
npm run build
npm run server:check
```

Contributions should include screenshots made with nonprivate demo content for interface changes. Keep existing workflows and permission boundaries intact.

## Credits and licenses

Application code: [GNU GPL version 3](LICENSE) (`GPL-3.0-only`), copyright **bashpacks**. External components and model weights retain their own terms; see the [workflow license inventory](docs/LICENSE-INVENTORY.md). The application license does not grant rights to third-party models, nodes or media.

The pictures and clips on the tool cards and heroes are AI-generated with Midjourney by the author; the FotoField card uses a Pexels photo (see `fixtures/real/SOURCES.md`).

Made by **bashpacks**.
