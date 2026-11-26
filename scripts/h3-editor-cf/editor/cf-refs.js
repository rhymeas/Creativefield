// CreativeField: the Film Studio's references panel (user 2026-11-25, Pad).
//
// The editor keeps every reference as a cast member with a kind (cf_refs.py): person, item, location, style
// (look and light) or outfit. This module shows them in one section per kind, takes one or many pictures dropped
// on the panel or on a clip, and sorts each new picture into its kind with a local text model that sees pictures,
// run by this ComfyUI with its own Generate Text node. The kind it proposes stays editable under "Used as".
//
// A dropped picture is: uploading -> sorting -> sorted. Sorting that fails leaves it a person and says so, so the
// user picks the kind. Only the sorting state lives here; everything else is the project's cast.

export const KINDS = [
  ["person", "People", "Person"],
  ["location", "Places", "Place"],
  ["item", "Props", "Prop"],
  ["style", "Look", "Look"],   // look and light; the short word keeps the group heading on one line
  ["outfit", "Outfits", "Outfit"],
];
const WORD = { person: "person", item: "item", location: "location", look: "style", style: "style", outfit: "outfit" };

// Text models with vision that ComfyUI may hold, best first. The writer's own choice is tried when none is installed.
const MODELS = ["qwen3.5_9b_prompt_upsampler_w4a8.safetensors", "qwen3.5_9b_w4a8_gptq.safetensors",
  "qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors"];
const SYSTEM = "You sort reference pictures for a film. Answer with exactly one word from this list: "
  + "person, item, location, look, outfit. person = a character or creature the shot shows. "
  + "item = an object or prop, a robot or a vehicle. location = a place, room or landscape. "
  + "look = a picture used only for its light, colours or mood. outfit = clothes shown without a person.";

let tools = null;             // () => the editor's toolbox, from editor.js (bind)
export const bind = (get) => { tools = get; };

const sorting = new Set();   // ids of cast members whose kind is still being worked out
export const isSorting = (id) => sorting.has(id);

export const kindOf = (person) => (KINDS.some(([k]) => k === person.kind) ? person.kind : "person");

// The next free name for a kind: Place 1, Place 2, ... so @Place 2 can be written in a shot at once.
export function nextName(cast, kind) {
  const base = (KINDS.find(([k]) => k === kind) || KINDS[0])[2];
  const taken = new Set(cast.map((p) => p.name));
  let n = 1;
  while (taken.has(base + " " + n)) n += 1;
  return base + " " + n;
}

let model = null;
async function pickModel() {
  if (model) return model;
  const info = await fetch("/object_info/CLIPLoader").then((r) => r.json()).catch(() => null);
  const names = info?.CLIPLoader?.input?.required?.clip_name?.[0] || [];
  model = MODELS.find((name) => names.includes(name)) || null;
  return model;
}

// The kind a picture shows, from the local model: one of KINDS' ids, or null when it cannot tell.
export async function sortPicture(asset) {
  const name = await pickModel();
  if (!name) return null;
  const image = (asset.subfolder ? asset.subfolder + "/" : "") + asset.file + " [output]";
  const graph = {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: name, type: "minimax", device: "default" } },
    "2": { class_type: "PrimitiveStringMultiline", inputs: { value: SYSTEM } },
    "3": { class_type: "TextGenerateV2", inputs: { clip: ["1", 0], prompt: "Which one word fits this reference picture?", max_length: 8,
      sampling_mode: "off", thinking: false, use_default_template: true, mtp: "auto", system_prompt: ["2", 0], "images.image1": ["10", 0] } },
    "4": { class_type: "PreviewAny", inputs: { source: ["3", 0] } },
    "10": { class_type: "LoadImage", inputs: { image } },
  };
  const sent = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, front: true }) }).then((r) => r.json()).catch(() => ({}));
  if (!sent.prompt_id) return null;
  const until = Date.now() + 5 * 60 * 1000;   // it waits behind a render that is running
  while (Date.now() < until) {
    await new Promise((done) => setTimeout(done, 800));
    const entry = (await fetch("/history/" + sent.prompt_id).then((r) => r.json()).catch(() => ({})))[sent.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") return null;
    const text = entry.outputs?.["4"]?.text?.[0];
    if (typeof text === "string") return WORD[(text.toLowerCase().match(/[a-z]+/) || [""])[0]] || null;
  }
  return null;
}

// Pictures dropped or picked: each becomes a reference at once (named for now as a person), then is sorted.
// ed is the editor's toolbox: { project(), upload(file), save(), render(), toast(text, bad), select(id), clipOf(id), uid }
// clip, when given, takes every new reference into its cast.
export async function addPictures(files, ed, clip = null) {
  const pictures = [...files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!pictures.length) return ed.toast("Drop pictures: PNG, JPEG or WebP files.", true);
  const added = [];
  for (const file of pictures) {
    try {
      const asset = await ed.upload(file);
      const cast = (ed.project().cast = ed.project().cast || []);
      const person = { id: ed.uid("p"), name: nextName(cast, "person"), description: "", kind: "person", ...asset };
      cast.push(person);
      const live = clip && ed.clipOf(clip.id);   // the live clip: the project may have been read again
      if (live) live.cast = [...(live.cast || []), person.id];
      sorting.add(person.id);
      added.push([person, asset]);
    } catch (error) {
      ed.toast(file.name + ": " + error.message, true);
    }
  }
  if (!added.length) return;
  if (!clip && added.length === 1) ed.select(added[0][0].id);
  ed.save();
  ed.render();
  let unsure = 0;
  for (const [person, asset] of added) {
    const kind = await sortPicture(asset);
    sorting.delete(person.id);
    const live = (ed.project().cast || []).find((p) => p.id === person.id);
    if (!live) continue;   // removed while it was being sorted
    if (!kind) unsure += 1;
    else if (kind !== live.kind) {
      const wasAuto = /^Person \d+$/.test(live.name);
      live.kind = kind;
      if (wasAuto) live.name = nextName(ed.project().cast.filter((p) => p.id !== live.id), kind);
    }
    ed.save();
    ed.render();
  }
  const where = clip ? " and in " + clip.name : "";
  ed.toast(added.length + (added.length === 1 ? " reference" : " references") + " added" + where + "."
    + (unsure ? " " + unsure + " could not be sorted: pick its kind under Used as." : ""), Boolean(unsure));
}

// The file picker, letting the user choose several pictures at once.
export function pickMany(input) {
  return new Promise((resolve) => {
    input.multiple = true;
    input.value = "";
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

// A place one or many picture files can be dropped on; it lights up while files are dragged over it.
// Cast tiles dragged inside the editor are left to the editor's own handlers.
export function dropMany(element, take) {
  if (element.dataset.cfDrop) return;
  element.dataset.cfDrop = "1";
  const files = (event) => [...(event.dataTransfer?.items || [])].some((row) => row.kind === "file");
  let depth = 0;
  element.addEventListener("dragenter", (event) => {
    if (!files(event)) return;
    event.preventDefault();
    depth += 1;
    element.classList.add("drop-hot");
  });
  element.addEventListener("dragover", (event) => {
    if (!files(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  element.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) element.classList.remove("drop-hot");
  });
  element.addEventListener("drop", (event) => {
    if (!files(event)) return;
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    element.classList.remove("drop-hot");
    take([...event.dataTransfer.files]);
  });
}

// The cast panel's tiles grouped under one heading per kind, in KINDS' order; empty kinds are left out.
export function group(list, cast, tiles) {
  const byId = new Map(tiles.map((tile) => [tile.dataset.person, tile]));
  const groups = [];
  const placed = new Set();
  const block = (title, members) => {
    // A group is as wide as its tiles, up to the panel's three columns, so small groups share a row.
    const box = document.createElement("div");
    box.className = "cf-ref-group";
    box.style.setProperty("--n", String(Math.min(3, members.length)));
    const head = document.createElement("h3");
    head.className = "cf-ref-head";
    head.textContent = title;
    box.append(head, ...members);
    groups.push(box);
  };
  for (const [kind, title] of KINDS) {
    const members = cast.filter((p) => p.file && kindOf(p) === kind && byId.has(p.id));
    if (!members.length) continue;
    block(title, members.map((p) => {
      placed.add(p.id);
      const tile = byId.get(p.id);
      if (sorting.has(p.id)) {
        tile.classList.add("cf-sorting");
        tile.title = "Sorting this picture";
      }
      if (tools) dress(tile, p);
      return tile;
    }));
  }
  // Voices and RefMods without a picture.
  const rest = cast.filter((p) => !placed.has(p.id) && byId.has(p.id)).map((p) => {
    const tile = byId.get(p.id);
    if (tools) dress(tile, p);
    return tile;
  });
  if (rest.length) block("Voices and RefMods", rest);
  list.replaceChildren(...groups);
}

// A clip's reference picks grouped by kind; small groups sit side by side.
export function groupPicks(picks, cast) {
  const tiles = [...picks.children];
  const pictured = cast.filter((p) => p.file || p.refmod);
  const parts = [];
  for (const [kind, title] of KINDS) {
    const rows = pictured.map((p, i) => [p, tiles[i]]).filter(([p, tile]) => tile && kindOf(p) === kind);
    if (!rows.length) continue;
    const box = document.createElement("div");
    box.className = "cf-pick-group";
    const head = document.createElement("span");
    head.className = "cf-ref-head";
    head.textContent = title;
    const row = document.createElement("div");
    row.className = "cf-pick-row";
    row.append(...rows.map(([, tile]) => tile));
    box.append(head, row);
    parts.push(box);
  }
  picks.replaceChildren(...parts);
}

// Menus show only their titles; each one's description becomes its hover text (user 2026-11-25).
function tidyMenus(root = document) {
  for (const button of root.querySelectorAll(".menu button")) {
    const words = button.querySelector(":scope > b + span");
    if (words && !button.title) button.title = words.textContent.trim();
  }
}
if (typeof document !== "undefined") {
  const start = () => {
    tidyMenus();
    const watch = new MutationObserver(() => tidyMenus());   // menus whose items are drawn later
    for (const menu of document.querySelectorAll(".menu")) watch.observe(menu, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}

// A tile's own ways: x removes the reference (with undo), a picture dropped on it replaces its picture.
function dress(tile, person) {
  const x = document.createElement("span");
  x.className = "picture-remove cf-tile-x";
  x.setAttribute("role", "button");
  x.setAttribute("aria-label", "Remove " + person.name);
  x.title = "Remove " + person.name;
  x.textContent = "×";
  x.addEventListener("click", (event) => {
    event.stopPropagation();
    tools().remove(person);
  });
  tile.append(x);
  if (person.file) {
    const open = document.createElement("span");
    open.className = "picture-remove cf-tile-open";
    open.setAttribute("role", "button");
    open.setAttribute("aria-label", "Open " + person.name + " in full view");
    open.title = "Open in full view: zoom, upscale, annotate";
    open.textContent = "\u2922";
    open.addEventListener("click", (event) => {
      event.stopPropagation();
      view(person);
    });
    tile.append(open);
    tile.addEventListener("dblclick", () => view(person));
    if (!tile.title) tile.title = "Drop a picture here to replace the picture of " + person.name;
    dropMany(tile, (files) => replacePicture(person, files));
  }
}

// The main picture of a reference swapped for another; its name, kind, clips and other pictures stay.
export async function replacePicture(person, files) {
  const file = [...files].find((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!file) return tools().toast("Drop a picture: a PNG, JPEG or WebP file.", true);
  const t = tools();
  try {
    const asset = await t.upload(file);
    const live = (t.project().cast || []).find((p) => p.id === person.id);
    if (!live) return;
    t.checkpoint();
    Object.assign(live, asset);
    t.save();
    t.render();
    t.toast("Replaced the picture of " + live.name + ".", false, t.undoAction);
    return live;
  } catch (error) {
    t.toast(error.message, true);
    return null;
  }
}

// The reference's panel: its picture opens the viewer and takes a dropped picture, and Replace sits under the words.
export function dressPortrait(card, person) {
  const image = card.querySelector("img");
  const words = card.querySelector(".person-words");
  if (image) {
    image.classList.add("cf-portrait");
    image.title = "Open " + person.name + " (drop a picture here to replace it)";
    image.addEventListener("click", () => view(person));
    dropMany(image, (files) => replacePicture(person, files));
  }
  const column = document.createElement("div");
  column.className = "cf-portrait-text";
  words?.replaceWith(column);
  column.append(...(words ? [words] : []), replaceButton(person));
}

export function replaceButton(person) {
  const b = document.createElement("button");
  b.className = "quiet cf-replace";
  b.textContent = "Replace";
  b.title = "Choose or drop another picture; the name, kind and clips stay";
  b.addEventListener("click", async () => {
    const files = await pickMany(document.getElementById("castFile"));
    if (files.length) replacePicture(person, files.slice(0, 1));
  });
  dropMany(b, (files) => replacePicture(person, files));
  return b;
}

// A picture viewer: the wheel zooms where the pointer is, dragging pans, a double click fits it again.
// Upscale and Annotate edit the picture here and save it back into the reference (cf-quickedit.js).
// Modes: view -> annotate (draw boxes, say what changes) -> working -> view with the new picture; a failure
// says why and goes back to where it was, boxes kept.
export function view(person) {
  const t = tools();
  let dialog = document.getElementById("cfViewer");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "cfViewer";
    dialog.className = "cf-viewer";
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  const live = () => (t.project().cast || []).find((p) => p.id === person.id) || person;
  let mode = "view", busy = "", boxes = [];
  const stage = document.createElement("div");
  stage.className = "cf-viewer-stage";
  const image = document.createElement("img");
  image.alt = live().name;
  image.src = t.assetUrl(live());
  image.draggable = false;
  const layer = document.createElement("div");
  layer.className = "cf-annot-layer";
  stage.append(image, layer);
  let zoom = 1, x = 0, y = 0;
  const place = () => { image.style.transform = "translate(" + x + "px, " + y + "px) scale(" + zoom + ")"; };
  const fit = () => { zoom = 1; x = y = 0; place(); };
  stage.addEventListener("wheel", (event) => {
    if (mode !== "view") return;
    event.preventDefault();
    const box = stage.getBoundingClientRect();
    const px = event.clientX - box.left - box.width / 2 - x, py = event.clientY - box.top - box.height / 2 - y;
    const next = Math.min(8, Math.max(1, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    x -= px * (next / zoom - 1);
    y -= py * (next / zoom - 1);
    zoom = next;
    if (zoom === 1) x = y = 0;
    place();
  }, { passive: false });
  // The layer lies exactly over the picture as shown, so boxes are kept in the picture's own fractions.
  const cover = () => {
    const s = stage.getBoundingClientRect(), r = image.getBoundingClientRect();
    Object.assign(layer.style, { left: r.left - s.left + "px", top: r.top - s.top + "px", width: r.width + "px", height: r.height + "px" });
  };
  const fitToStage = () => {
    const s = stage.getBoundingClientRect(), w = image.naturalWidth, h = image.naturalHeight;
    if (!w || !h || !s.width || !s.height) return;
    const scale = Math.min(s.width / w, s.height / h);
    image.style.width = Math.round(w * scale) + "px";
    image.style.height = Math.round(h * scale) + "px";
    if (mode === "annotate") cover();
  };
  image.addEventListener("load", fitToStage);
  const watch = new ResizeObserver(fitToStage);
  watch.observe(stage);
  dialog.addEventListener("close", () => watch.disconnect(), { once: true });
  let drag = null, drawing = null;
  stage.addEventListener("pointerdown", (event) => {
    if (busy) return;
    try { stage.setPointerCapture(event.pointerId); } catch (_) {}
    if (mode === "annotate") {
      if (boxes.length >= 8) return t.toast("Up to 8 boxes at once.", true);
      const r = layer.getBoundingClientRect();
      const fx = (event.clientX - r.left) / r.width, fy = (event.clientY - r.top) / r.height;
      if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return;
      drawing = { sx: fx, sy: fy, x: fx, y: fy, w: 0, h: 0 };
    } else if (mode === "view") drag = [event.clientX - x, event.clientY - y];
  });
  stage.addEventListener("pointermove", (event) => {
    if (drawing) {
      const r = layer.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, (event.clientY - r.top) / r.height));
      Object.assign(drawing, { x: Math.min(drawing.sx, fx), y: Math.min(drawing.sy, fy), w: Math.abs(fx - drawing.sx), h: Math.abs(fy - drawing.sy) });
      drawBoxes(drawing);
    } else if (drag && zoom > 1) { x = event.clientX - drag[0]; y = event.clientY - drag[1]; place(); }
  });
  stage.addEventListener("pointerup", () => {
    drag = null;
    if (!drawing) return;
    const done = drawing;
    drawing = null;
    if (done.w > 0.02 && done.h > 0.02) {
      boxes.push({ x: done.x, y: done.y, w: done.w, h: done.h, instruction: "" });
      draw();
      layer.querySelectorAll(".cf-annot-note input")[boxes.length - 1]?.focus();
    } else drawBoxes();
  });
  stage.addEventListener("dblclick", () => { if (mode === "view") fit(); });
  function drawBoxes(extra = null) {
    const parts = [];
    [...boxes, ...(extra ? [extra] : [])].forEach((b, i) => {
      const el = document.createElement("div");
      el.className = "cf-annot-box";
      Object.assign(el.style, { left: b.x * 100 + "%", top: b.y * 100 + "%", width: b.w * 100 + "%", height: b.h * 100 + "%" });
      parts.push(el);
      if (i >= boxes.length) return;
      el.dataset.n = String(i + 1);
      // The note sits under the box, or over it when the box reaches the picture's bottom.
      const note = document.createElement("div");
      note.className = "cf-annot-note";
      note.style.left = Math.min(b.x, 0.62) * 100 + "%";
      el.classList.toggle("note-above", b.y + b.h > 0.86);
      if (b.y + b.h > 0.86) note.style.bottom = (1 - b.y) * 100 + "%";
      else note.style.top = (b.y + b.h) * 100 + "%";
      note.addEventListener("pointerdown", (event) => event.stopPropagation());
      const input = document.createElement("input");
      input.placeholder = "What should change here";
      input.value = b.instruction;
      input.disabled = Boolean(busy);
      input.addEventListener("input", () => {
        b.instruction = input.value;
        const apply = [...dialog.querySelectorAll(".cf-viewer-bar button")].find((el) => el.textContent === "Apply");
        if (apply) apply.disabled = Boolean(busy) || !boxes.every((one) => one.instruction.trim());
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") [...dialog.querySelectorAll(".cf-viewer-bar button")].find((el) => el.textContent === "Apply" && !el.disabled)?.click();
      });
      const remove = document.createElement("button");
      remove.className = "quiet cf-annot-remove";
      remove.textContent = "\u00d7";
      remove.title = "Remove this box";
      remove.disabled = Boolean(busy);
      remove.addEventListener("click", () => { boxes.splice(i, 1); draw(); });
      note.append(input, remove);
      parts.push(note);
    });
    layer.replaceChildren(...parts);
  }
  const button = (text, click, primary = false, title = "") => {
    const b = document.createElement("button");
    b.className = primary ? "primary" : "quiet";
    b.textContent = text;
    if (title) b.title = title;
    b.disabled = Boolean(busy);
    b.addEventListener("click", click);
    return b;
  };
  async function work(what, job) {
    busy = what;
    draw();
    try {
      const blob = await job();
      const done = await replacePicture(live(), [new File([blob], "edited.png", { type: "image/png" })]);
      if (done) {
        image.src = t.assetUrl(done);
        boxes = [];
        mode = "view";
        fit();
      }
    } catch (error) {
      t.toast(error.message || String(error), true);
    } finally {
      busy = "";
      draw();
    }
  }
  function draw() {
    stage.classList.toggle("annotating", mode === "annotate");
    layer.hidden = mode !== "annotate";
    if (mode === "annotate") drawBoxes();
    const bar = document.createElement("div");
    bar.className = "cf-viewer-bar";
    const title = document.createElement("b");
    title.textContent = busy ? busy + "..." : live().name;
    const parts = [title];
    if (mode === "view") {
      parts.push(
        button("Upscale", () => work("Upscaling", () => t.quick.upscale(t.assetUrl(live()))), false, "Enlarge the picture 2x with RealESRGAN and keep it here"),
        button("Annotate", () => { mode = "annotate"; fit(); draw(); }, false, "Draw boxes on the picture and say what should change in each"),
      );
      const replace = replaceButton(live());
      replace.disabled = Boolean(busy);
      replace.addEventListener("click", () => dialog.close());
      parts.push(replace);
    } else {
      const apply = button("Apply", () => work("Editing", () => t.quick.annotate(t.assetUrl(live()), boxes,
        (i, n) => { busy = "Editing " + i + " of " + n; title.textContent = busy + "..."; })), true, "Edit every box and save the picture");
      apply.disabled = Boolean(busy) || !boxes.length || !boxes.every((b) => b.instruction.trim());
      parts.push(apply, button("Cancel", () => { mode = "view"; boxes = []; draw(); }));
    }
    bar.append(...parts);
    const list = document.createElement("div");
    list.className = "cf-annot-list";
    if (mode === "annotate") {
      if (!boxes.length) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = "Drag a box over what should change, then say what it should become.";
        list.append(hint);
      }
    }
    const close = document.createElement("button");
    close.className = "quiet cf-viewer-close";
    close.textContent = "\u00d7";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dialog.close());
    dialog.replaceChildren(stage, list, bar, close);
    if (mode === "annotate") requestAnimationFrame(cover);
  }
  draw();
  if (!dialog.open) dialog.showModal();
}

// Notes rendered as a change (IDEA-2616): a clip's open notes with a box, pin or drawing on its shown take are sent to
// the server, which renders the clip again holding that take and regenerating only the marked areas (cf_region.py).
export function notesActions(notes, t) {
  const byClip = new Map();
  for (const note of notes) {
    if (note.status === "resolved" || !note.shape) continue;
    const clip = t.clipOf(note.clip);
    if (!clip || t.activeTake(clip)?.id !== note.take) continue;
    byClip.set(clip, [...(byClip.get(clip) || []), note]);
  }
  return [...byClip].map(([clip, rows]) => {
    const row = document.createElement("div");
    row.className = "cf-notes-render";
    const what = document.createElement("span");
    what.textContent = clip.name + ": " + rows.length + (rows.length === 1 ? " marked note" : " marked notes");
    const go = (quality) => async () => {
      try {
        await t.flush();
        const result = await t.postJson("/project/" + t.state.folder + "/render_notes", { clip: clip.id, quality, client_id: t.clientId });
        t.state.jobs.set(result.job.id, { ...result.job, step: 0, max: 0, progress: 0 });
        t.adopt(result.project);
        t.updateQueue();
        t.renderAll();
        t.toast(clip.name + " renders again with " + result.notes.length + (result.notes.length === 1 ? " note" : " notes")
          + ": only the marked areas change. It arrives as a new take.");
      } catch (error) {
        t.toast(error.message, true);
      }
    };
    const draft = document.createElement("button");
    draft.className = "quiet";
    draft.textContent = "Render draft";
    draft.title = "Hold this take and regenerate only what the notes mark";
    draft.addEventListener("click", go("draft"));
    const final = document.createElement("button");
    final.className = "primary";
    final.textContent = "Render final";
    final.title = "The same at final size";
    final.addEventListener("click", go("final"));
    row.append(what, draft, final);
    return row;
  });
}

// A note's words sit at its mark (user 2026-11-26): the saved note's line under the box, pin or drawing on the frame,
// and the writing box under the shape being drawn, or above it when there is no room below.
function boundsOf(shape) {
  if (!shape) return null;
  if (shape.type === "rect") return { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  const points = shape.type === "pin" ? [[shape.x, shape.y]] : (shape.paths || []).flat();
  if (!points.length) return null;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function placeAt(el, bounds, rect) {
  const host = el.offsetParent || el.parentElement;
  if (!bounds || !rect || !host || el.hidden) {
    el.style.left = el.style.top = el.style.right = "";
    return;
  }
  const gap = 8, w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(gap, Math.min(host.clientWidth - w - gap, rect.left + bounds.x * rect.width));
  let top = rect.top + (bounds.y + bounds.h) * rect.height + gap;
  if (top + h > host.clientHeight - gap) top = Math.max(gap, rect.top + bounds.y * rect.height - h - gap);
  Object.assign(el.style, { left: left + "px", top: top + "px", right: "auto" });
}
export function placeNotes(tag, box, here, rect, writing) {
  placeAt(tag, boundsOf(here.find((n) => n.shape)?.shape), rect);
  if (box.classList.contains("moved")) return;   // the user dragged it somewhere: it stays there
  placeAt(box, writing && !writing.drawing ? boundsOf(writing.shape) : null, rect);
}
