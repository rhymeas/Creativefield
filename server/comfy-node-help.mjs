/** Local, reviewed explanations. No prompts, graphs or images leave the editor. */
const guides = {
  KSampler: "Creates the image by gradually turning random noise into a result guided by your prompt and model. Steps controls how many passes it makes; Seed changes the starting noise; Guidance (CFG) controls how strongly it follows the prompt; Denoise controls how much it changes the starting image. Its output is still an encoded image: connect it to VAE Decode to see the picture.",
  KSamplerAdvanced: "An advanced image generator that lets you choose exactly which part of the noise-removal process to run. Use it for staged generation or when continuing work from another sampler. Start/end steps and the noise options must match the rest of your workflow.",
  CLIPTextEncode: "Turns your written prompt into instructions the image model can use. A positive prompt describes what you want; a negative prompt describes what to avoid. Connect its output to the matching prompt input on the sampler.",
  VAEDecode: "Turns the model’s compact, encoded image into a normal picture you can preview or save. It needs the VAE that matches the model used to generate it.",
  VAEEncode: "Turns a normal picture into the compact image format used by the generator. Use it when you want to edit or transform an existing picture.",
  CheckpointLoaderSimple: "Loads the main image-generation package. It usually provides the image model, a text encoder for reading prompts, and a VAE for converting between pictures and the model’s encoded format.",
  UNETLoader: "Loads the main model that creates or changes the image. This loader supplies only the image model; the workflow also needs compatible text encoders and a VAE.",
  CLIPLoader: "Loads the text encoder that translates your prompt for the image model. Choose the encoder and type required by your model; different model families are not interchangeable.",
  DualCLIPLoader: "Loads two text encoders that work together to read your prompt. Both encoders and the selected type need to match the image model.",
  VAELoader: "Loads the converter between normal pictures and the model’s compact image format. Choose the VAE that matches your image model.",
  EmptyLatentImage: "Sets the width, height and number of images to generate from scratch. It provides an empty encoded starting image for the sampler.",
  EmptySD3LatentImage: "Sets the output dimensions and image count for models that use this encoded image format, including compatible SD3 and Flux workflows. Use the size and format expected by your model.",
  SaveImage: "Saves the finished pictures to ComfyUI’s output folder. The filename prefix controls the start of the saved filenames. This receives a normal image, so decode the sampler output first.",
  PreviewImage: "Shows the finished pictures in the workflow so you can inspect them. It does not replace the Save Image node when you want normal output files.",
  LoadImage: "Opens a picture to use as a source or reference. The image output supplies its pixels; the mask output can describe which area to edit, depending on the workflow.",
  LoraLoader: "Adds a compatible LoRA to change a model’s style, subject or behavior. Model strength affects image generation; text strength affects prompt interpretation. The LoRA must match the base model family.",
  ModelSamplingAuraFlow: "Adjusts the generation schedule used by compatible flow-based models. Shift changes how effort is distributed across the generation process. Keep the value recommended by your model or workflow unless you are experimenting.",
};

export function explainNode(type, metadata = {}) {
  if (guides[type]) return { text: guides[type], source: "ComfyField guide" };
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  if (description) return { text: description, source: "Node author’s description" };
  const inputs = Object.keys(metadata.input?.required ?? {}).slice(0, 8);
  const outputs = Array.isArray(metadata.output_name) ? metadata.output_name : [];
  return { text: "This node has no explanation from its author yet." +
    (inputs.length ? " Required inputs: " + inputs.join(", ") + "." : "") +
    (outputs.length ? " Outputs: " + outputs.join(", ") + "." : ""), source: "Available node metadata" };
}

export function explainError(text) {
  if (/mat1 and mat2 shapes cannot be multiplied/i.test(text)) return {
    title: "Model and text encoder do not match",
    hint: "Choose a workflow made for this model family. Its model and prompt encoder must be compatible.",
  };
  return {
    title: "This workflow step could not run",
    hint: "Check the highlighted node and its connected inputs, then try again.",
  };
}

async function installNodeHelp() {
  const tip = document.createElement("div");
  tip.className = "cf-node-help-tooltip";
  tip.id = "cf-node-help-tooltip";
  tip.role = "tooltip";
  tip.hidden = true;
  document.body.append(tip);
  let anchor = null;
  let hideTimer = 0;
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 120); }
  function hide() {
    clearTimeout(hideTimer);
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
    tip.hidden = true;
  }
  function show(button) {
    clearTimeout(hideTimer);
    const element = button.closest(".lg-node");
    const app = window.comfyAPI?.app?.app ?? window.app;
    const node = (app?.canvas?.graph ?? app?.graph)?.getNodeById(element?.dataset.nodeId);
    if (!node) return;
    const info = explainNode(node.type, node.constructor.nodeData ?? {});
    const title = document.createElement("strong");
    title.textContent = node.title || node.type;
    const body = document.createElement("p");
    body.textContent = info.text;
    const source = document.createElement("small");
    source.textContent = info.source;
    tip.replaceChildren(title, body, source);
    anchor?.removeAttribute("aria-describedby");
    anchor = button;
    button.setAttribute("aria-describedby", tip.id);
    tip.hidden = false;
    const rect = button.getBoundingClientRect();
    const gutter = 12;
    tip.style.left = Math.max(gutter, Math.min(rect.right + gutter, innerWidth - tip.offsetWidth - gutter)) + "px";
    tip.style.top = Math.max(gutter, Math.min(rect.top, innerHeight - tip.offsetHeight - gutter)) + "px";
  }
  function enhance(node) {
    const row = node.querySelector(".lg-node-header > div");
    if (!row || row.querySelector(".cf-node-help")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cf-node-help";
    button.textContent = "ⓘ";
    button.setAttribute("aria-label", "Explain this node");
    button.addEventListener("pointerdown", e => e.stopPropagation());
    button.addEventListener("dblclick", e => e.stopPropagation());
    button.addEventListener("pointerenter", () => show(button));
    button.addEventListener("pointerleave", () => { if (document.activeElement !== button) scheduleHide(); });
    button.addEventListener("focus", () => show(button));
    button.addEventListener("blur", () => { if (!tip.matches(":hover")) hide(); });
    button.addEventListener("click", e => { e.stopPropagation(); show(button); });
    row.append(button);
  }
  tip.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  tip.addEventListener("pointerleave", () => { if (document.activeElement !== anchor) scheduleHide(); });
  document.querySelectorAll(".lg-node").forEach(enhance);
  const pending = new Set();
  let frame = 0;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const parent = record.target instanceof Element ? record.target.closest(".lg-node") : null;
      if (parent) pending.add(parent);
      for (const added of record.addedNodes) {
        if (!(added instanceof Element) || added === tip) continue;
        if (added.matches(".lg-node")) pending.add(added);
        added.querySelectorAll(".lg-node").forEach(node => pending.add(node));
      }
    }
    if (anchor && !anchor.isConnected) hide();
    if (pending.size && !frame) frame = requestAnimationFrame(() => {
      frame = 0;
      pending.forEach(node => { if (node.isConnected) enhance(node); });
      pending.clear();
    });
    scheduleErrorSummaries();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  document.addEventListener("pointerdown", e => { if (!e.target.closest(".cf-node-help,.cf-node-help-tooltip")) hide(); }, true);
  addEventListener("resize", hide);
  document.addEventListener("scroll", hide, true);
  addEventListener("pagehide", () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(hideTimer); }, { once: true });
}

function installErrorSummaries() {
  const summaries = new WeakMap();
  let frame = 0;
  function makeSummary(report) {
    const text = report.textContent || "";
    let item = summaries.get(report);
    if (!item) {
      const card = document.createElement("section");
      card.className = "cf-error-summary";
      card.setAttribute("aria-live", "polite");
      const heading = document.createElement("strong");
      heading.className = "cf-error-summary__title";
      const hint = document.createElement("p");
      hint.className = "cf-error-summary__hint";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cf-error-summary__advanced";
      button.textContent = "Advanced details";
      const dialog = document.createElement("dialog");
      dialog.className = "cf-error-details";
      dialog.setAttribute("aria-label", "Advanced error details");
      const dialogTitle = document.createElement("strong");
      dialogTitle.textContent = "Error details";
      const raw = document.createElement("pre");
      const close = document.createElement("button");
      close.type = "button";
      close.className = "cf-error-summary__advanced";
      close.textContent = "Close";
      close.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      button.addEventListener("click", () => {
        raw.textContent = report.textContent || "No additional error details were provided.";
        if (!dialog.open) dialog.showModal();
      });
      dialog.append(dialogTitle, raw, close);
      card.append(heading, hint, button);
      report.hidden = true;
      report.setAttribute("aria-hidden", "true");
      report.parentElement?.insertBefore(card, report);
      document.body.append(dialog);
      item = { card, heading, hint, dialog, raw };
      summaries.set(report, item);
    }
    const { title, hint } = explainError(text);
    item.heading.textContent = title;
    item.hint.textContent = hint;
  }
  function scan() {
    frame = 0;
    const candidates = [...document.querySelectorAll("div, pre, section")]
      .filter(element => {
        const text = element.textContent || "";
        return text.length > 80 && /ComfyUI Error Report/i.test(text) && /Exception Message:/i.test(text);
      })
      .sort((a, b) => (a.textContent?.length ?? Infinity) - (b.textContent?.length ?? Infinity));
    for (const report of candidates.slice(0, 1)) makeSummary(report);
  }
  function scheduleErrorSummaries() {
    if (!frame) frame = requestAnimationFrame(scan);
  }
  scan();
  const observer = new MutationObserver(scheduleErrorSummaries);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  addEventListener("pagehide", () => { observer.disconnect(); cancelAnimationFrame(frame); }, { once: true });
  return scheduleErrorSummaries;
}

let scheduleErrorSummaries = () => {};
if (typeof document !== "undefined" && document.documentElement.dataset.comfyfield && !document.documentElement.dataset.comfyfieldHelp) {
  document.documentElement.dataset.comfyfieldHelp = "1";
  scheduleErrorSummaries = installErrorSummaries();
  installNodeHelp().catch(error => console.warn("ComfyField node help could not start", error));
}
