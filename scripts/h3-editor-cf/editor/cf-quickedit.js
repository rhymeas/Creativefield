// CreativeField: quick edits of a reference picture inside the Film Studio's picture viewer (user 2026-11-25).
//
// Two of FotoField's tools, run on this ComfyUI and saved back into the reference without leaving the editor:
//   Upscale   RealESRGAN x4, brought to 2x (the app's upscale-image-esrgan workflow), capped at about 8 MP.
//   Annotate  boxes drawn on the picture, each with what should change. Every box is edited on its own crop with
//             FLUX 3 Klein (the app's flux2-klein-edit model files) and only the box's inside is pasted back,
//             feathered, as FotoField's annotations do (src/image/annotations.ts annotationCropInstruction).
// The finished picture replaces the reference's picture (undo brings the old one back).

const POLL_MS = 700;
const MAX_UPSCALED_MP = 8;
const KLEIN = { unet: "flux3-image-klein-int8-convrot.safetensors", clip: "qwen3vl_4b_int8_convrot.safetensors", vae: "flux2-vae.safetensors" };

async function upload(blob, name) {
  const form = new FormData();
  form.append("image", blob, name);
  form.append("subfolder", "cf_quickedit");
  form.append("overwrite", "true");
  const reply = await fetch("/upload/image", { method: "POST", body: form });
  if (!reply.ok) throw new Error("ComfyUI would not take the picture.");
  const made = await reply.json();
  return (made.subfolder ? made.subfolder + "/" : "") + made.name;
}

// Runs a graph and returns the first picture its SaveImage node "9" wrote, as a Blob.
async function run(graph) {
  const sent = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, front: true }) }).then((r) => r.json()).catch(() => ({}));
  if (!sent.prompt_id) throw new Error("ComfyUI refused the edit: " + JSON.stringify(sent.node_errors || sent.error || sent).slice(0, 200));
  for (;;) {
    await new Promise((done) => setTimeout(done, POLL_MS));
    const entry = (await fetch("/history/" + sent.prompt_id).then((r) => r.json()).catch(() => ({})))[sent.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const last = (entry.status.messages || []).find((row) => row[0] === "execution_error")?.[1];
      throw new Error("The edit failed in ComfyUI: " + String(last?.exception_message || "see its log").slice(0, 200));
    }
    const image = entry.outputs?.["9"]?.images?.[0];
    if (image) {
      const url = "/view?" + new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
      return fetch(url).then((r) => r.blob());
    }
    if (entry.status?.completed) throw new Error("The edit finished without a picture.");
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture could not be read."));
    image.src = src;
  });
}
const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
function canvasOf(image, w = image.naturalWidth || image.width, h = image.naturalHeight || image.height) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(image, 0, 0, w, h);
  return canvas;
}

export async function upscale(src) {
  const image = await loadImage(src);
  const mp = (image.naturalWidth * image.naturalHeight) / 1e6;
  const factor = Math.min(2, Math.sqrt(MAX_UPSCALED_MP / mp));   // 2x, or less for a picture that is already large
  if (factor <= 1.05) throw new Error("The picture is already about " + Math.round(mp) + " MP.");
  const name = await upload(await toBlob(canvasOf(image)), "upscale.png");
  return run({
    "1": { class_type: "LoadImage", inputs: { image: name } },
    "2": { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.pth" } },
    "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
    "4": { class_type: "ImageScaleBy", inputs: { image: ["3", 0], upscale_method: "lanczos", scale_by: factor / 4 } },
    "9": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "cf_quickedit/upscale" } },
  });
}

function kleinEdit(imageName, prompt, seed) {
  return {
    "1": { class_type: "LoadImage", inputs: { image: imageName } },
    "2": { class_type: "ImageScaleToTotalPixels", inputs: { upscale_method: "lanczos", megapixels: 1, resolution_steps: 16, image: ["1", 0] } },
    "3": { class_type: "GetImageSize", inputs: { image: ["2", 0] } },
    "4": { class_type: "UNETLoader", inputs: { unet_name: KLEIN.unet, weight_dtype: "default" } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: KLEIN.clip, type: "flux3", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: KLEIN.vae } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["5", 0] } },
    "8": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["5", 0] } },
    "10": { class_type: "ModelSamplingFlux", inputs: { max_shift: Math.log(16), base_shift: Math.log(16), width: 1024, height: 1024, model: ["4", 0] } },
    "11": { class_type: "ReferenceMultiLatent", inputs: { resolution: "resize", "resolution.megapixels": 1, positive: ["7", 0], negative: ["8", 0], vae: ["6", 0], "images.image0": ["2", 0] } },
    "12": { class_type: "EmptyFlux2LatentImage", inputs: { width: ["3", 0], height: ["3", 1], batch_size: 1 } },
    "13": { class_type: "KSampler", inputs: { seed, steps: 16, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
      model: ["10", 0], positive: ["11", 0], negative: ["11", 1], latent_image: ["12", 0] } },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["6", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: "cf_quickedit/annotate" } },
  };
}

// boxes: [{x, y, w, h, instruction}] in 0..1 of the picture. progress(i, n) is called before each box.
export async function annotate(src, boxes, progress = () => {}) {
  const image = await loadImage(src);
  const W = image.naturalWidth, H = image.naturalHeight;
  const out = canvasOf(image);
  const ctx = out.getContext("2d");
  for (const [index, box] of boxes.entries()) {
    progress(index + 1, boxes.length);
    // The box in the middle of a crop with room around it, so the model sees where the change sits.
    const bx = box.x * W, by = box.y * H, bw = box.w * W, bh = box.h * H;
    const side = Math.min(Math.max(W, H), Math.max(512, Math.max(bw, bh) * 1.8));
    const cw = Math.min(W, Math.max(bw * 1.6, side)), ch = Math.min(H, Math.max(bh * 1.6, side));
    const cx = Math.round(Math.min(Math.max(0, bx + bw / 2 - cw / 2), W - cw)), cy = Math.round(Math.min(Math.max(0, by + bh / 2 - ch / 2), H - ch));
    const crop = document.createElement("canvas");
    crop.width = Math.round(cw);
    crop.height = Math.round(ch);
    crop.getContext("2d").drawImage(out, cx, cy, cw, ch, 0, 0, crop.width, crop.height);
    const prompt = "Change only this, the object or area in the middle of the picture: " + box.instruction
      + "\nKeep the framing, size, perspective, light and everything around it exactly as it is.";
    const edited = await loadImage(URL.createObjectURL(await run(kleinEdit(await upload(await toBlob(crop), "annotate.png"), prompt,
      Math.floor(Math.random() * 2 ** 31)))));
    // Only the box's inside comes back, with a soft edge.
    const patch = document.createElement("canvas");
    patch.width = crop.width;
    patch.height = crop.height;
    const p = patch.getContext("2d");
    p.drawImage(edited, 0, 0, crop.width, crop.height);
    const feather = Math.max(6, Math.round(Math.min(bw, bh) * 0.06));
    const mask = document.createElement("canvas");
    mask.width = crop.width;
    mask.height = crop.height;
    const m = mask.getContext("2d");
    m.filter = "blur(" + feather + "px)";
    m.fillStyle = "#fff";
    m.fillRect(bx - cx + feather, by - cy + feather, Math.max(1, bw - 2 * feather), Math.max(1, bh - 2 * feather));
    p.globalCompositeOperation = "destination-in";
    p.drawImage(mask, 0, 0);
    ctx.drawImage(patch, cx, cy);
  }
  return toBlob(out);
}
