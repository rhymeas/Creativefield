// CreativeField: reference packs in the Film Studio (user 2026-11-25, Pad).
//
// A pack is a named set of references kept once per install beside the cast catalog (cf_packs.py), for example
// "Pier at golden hour": Maya, Kip, the pier and the light. Saving stores each reference in the catalog with the
// editor's own catalog operations, then writes the pack's list of catalog entries. Using a pack brings each entry
// into the project (or brings a copy up to date when the catalog is newer) and, for a clip, makes the pack's
// references the clip's references. Everything is saved on the server, so it survives a reload.
//
// What is saved: the selected clip's references, or every reference of the project when no clip is selected.

let tools = null;            // () => the editor's toolbox, from editor.js
let packs = null;            // the packs as the server lists them; null until the dialog first loads them
let busy = "";               // what is running, shown in the dialog; the dialog's buttons wait for it
let name = "";               // the name typed for a new pack

export const bind = (get) => { tools = get; };

const pictured = (p) => Boolean(p.file || p.refmod);

// The references a save takes, and where they come from.
function scope() {
  const t = tools();
  const cast = t.state.project.cast || [];
  const clip = t.state.clip ? t.clipOf(t.state.clip) : null;
  if (clip) return { clip, members: cast.filter((p) => pictured(p) && (clip.cast || []).includes(p.id)) };
  return { clip: null, members: cast.filter(pictured) };
}

async function load() {
  packs = (await tools().api("/ref-packs")).packs || [];
  return packs;
}

function redraw() {
  if ($("panelDialog")?.open) tools().drawPanelDialog();
}
const $ = (id) => document.getElementById(id);

async function run(what, work) {
  if (busy) return;
  busy = what;
  redraw();
  try {
    await work();
  } catch (error) {
    tools().toast(error.message || String(error), true);
  } finally {
    busy = "";
    redraw();
  }
}

// Every reference of the scope in the catalog; returns their catalog ids in order, or null when that failed.
async function storeInCatalog(members) {
  const t = tools();
  const results = await t.catalogOps(members.map((p) => ({ op: "save_cast_to_catalog", cast: p.id })),
    () => members.length + (members.length === 1 ? " reference" : " references") + " kept in the catalog.");
  return results ? results.map((r) => r.catalog) : null;
}

async function savePack(body, done) {
  const { members } = scope();
  if (!members.length && body.mode !== "rename") throw new Error("Add references first: there is nothing to save.");
  const ids = body.mode === "rename" ? null : await storeInCatalog(members);
  if (body.mode !== "rename" && !ids) return;
  const reply = await tools().postJson("/ref-packs/save", { ...body, members: ids });
  packs = reply.packs || packs;
  tools().toast(done);
}

// Bring a pack into the project; for a clip its references become exactly the pack's.
async function usePack(pack, clipId) {
  const t = tools();
  const cast = () => t.state.project.cast || [];
  const ops = [];
  for (const m of pack.members) {
    const here = cast().find((p) => p.catalog?.id === m.catalog);
    if (!here) ops.push({ op: "add_cast_from_catalog", catalog: m.catalog });
    else if (t.catalogState(here) === "newer") ops.push({ op: "update_cast_from_catalog", cast: here.id });
  }
  if (ops.length && !(await t.catalogOps(ops, () => pack.name + ": " + ops.length + (ops.length === 1 ? " reference" : " references") + " brought in."))) return;
  const ids = pack.members.map((m) => cast().find((p) => p.catalog?.id === m.catalog)?.id).filter(Boolean);
  if (!clipId) {
    if (!ops.length) t.toast("Every reference of " + pack.name + " is already in this project.");
    return;
  }
  const clip = t.clipOf(clipId);   // after the operations the project was read again: take the live clip
  if (!clip) return;
  t.checkpoint();
  clip.cast = ids;
  t.save();
  t.renderAll();
  t.toast(clip.name + " now uses " + pack.name + ": " + ids.length + (ids.length === 1 ? " reference." : " references.")
    + (pack.missing ? " " + pack.missing + " left the catalog and stay out." : ""), false, t.undoAction);
}

function button(text, click, primary = false, title = "") {
  const b = document.createElement("button");
  b.className = (primary ? "primary" : "quiet") + " small";
  b.textContent = text;
  if (title) b.title = title;
  b.disabled = Boolean(busy);
  b.addEventListener("click", click);
  return b;
}

function strip(pack) {
  const box = document.createElement("div");
  box.className = "cf-pack-strip";
  for (const m of pack.members) {
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.alt = m.name;
    if (m.file) img.src = tools().assetUrl(m);
    const caption = document.createElement("figcaption");
    caption.textContent = m.name;
    figure.title = m.name + " (" + m.kind + ")";
    figure.append(img, caption);
    box.append(figure);
  }
  return box;
}

function card(pack, scoped) {
  const t = tools();
  const row = document.createElement("div");
  row.className = "cf-pack-card";
  const text = document.createElement("div");
  text.className = "cf-pack-text";
  const title = document.createElement("input");
  title.className = "name-input cf-pack-name";
  title.value = pack.name;
  title.setAttribute("aria-label", "Name of the pack");
  title.addEventListener("change", () => {
    const next = title.value.trim();
    if (!next || next === pack.name) { title.value = pack.name; return; }
    run("Renaming", () => savePack({ id: pack.id, mode: "rename", name: next }, "Renamed to " + next + "."));
  });
  const facts = document.createElement("span");
  facts.className = "catalog-facts";
  const kinds = [...new Set(pack.members.map((m) => m.kind))].length;
  facts.textContent = pack.members.length + (pack.members.length === 1 ? " reference" : " references")
    + (kinds > 1 ? " of " + kinds + " kinds" : "") + (pack.version > 1 ? ". Version " + pack.version : "")
    + (pack.missing ? ". " + pack.missing + " left the catalog" : "");
  text.append(title, facts, strip(pack));
  const ways = document.createElement("div");
  ways.className = "cf-pack-tools";
  const what = scoped.clip ? "the references of " + scoped.clip.name : "every reference of this project";
  if (scoped.clip) {
    ways.append(button("Use in " + scoped.clip.name, () => run("Using " + pack.name, () => usePack(pack, scoped.clip.id)), true,
      "Bring the pack in and make its references exactly the references of " + scoped.clip.name));
  }
  ways.append(
    button("Add to project", () => run("Bringing in " + pack.name, () => usePack(pack, null)), !scoped.clip,
      "Bring every reference of the pack into this project, or bring copies up to date"),
    button("Overwrite", () => run("Overwriting", () => savePack({ id: pack.id, mode: "overwrite" }, pack.name + " now holds " + what + ".")), false,
      "Replace the pack's references with " + what),
    button("Add these", () => run("Adding", () => savePack({ id: pack.id, mode: "extend" }, "Added " + what + " to " + pack.name + ".")), false,
      "Add " + what + " to the pack, keeping what it holds"),
    button("Delete", () => {
      if (!window.confirm("Delete the pack " + pack.name + "? Its references stay in the catalog and in every project.")) return;
      run("Deleting", async () => {
        packs = (await t.postJson("/ref-packs/remove", { id: pack.id })).packs || [];
        t.toast("Deleted the pack " + pack.name + ".");
      });
    }),
  );
  row.append(text, ways);
  return row;
}

function draw() {
  const scoped = scope();
  const parts = [];
  const intro = document.createElement("p");
  intro.className = "hint";
  intro.textContent = (scoped.clip
    ? "Saving takes the " + scoped.members.length + " references of " + scoped.clip.name + "."
    : "Saving takes all " + scoped.members.length + " references of this project. Select a clip to save or replace only its references.")
    + " Packs are kept for every project on this ComfyUI.";
  const make = document.createElement("div");
  make.className = "cf-pack-new field";
  const input = document.createElement("input");
  input.placeholder = "Name of the new pack";
  input.value = name;
  input.addEventListener("input", () => { name = input.value; });
  const go = button("Save as new pack", () => {
    const n = input.value.trim();
    if (!n) return tools().toast("Give the pack a name.", true);
    run("Saving " + n, async () => { await savePack({ mode: "new", name: n }, "Saved the pack " + n + "."); name = ""; });
  }, true);
  go.disabled = Boolean(busy) || !scoped.members.length;
  make.append(input, go);
  parts.push(intro, make);
  if (busy) {
    const doing = document.createElement("p");
    doing.className = "hint";
    doing.textContent = busy + "...";
    parts.push(doing);
  }
  if (packs === null) {
    const wait = document.createElement("p");
    wait.className = "hint";
    wait.textContent = "Loading the packs...";
    parts.push(wait);
  } else if (!packs.length) {
    const none = document.createElement("p");
    none.className = "hint";
    none.textContent = "No packs yet. Name one above to keep these references together for any project.";
    parts.push(none);
  } else {
    const grid = document.createElement("div");
    grid.className = "catalog-grid";
    grid.append(...packs.map((p) => card(p, scoped)));
    parts.push(grid);
  }
  return parts;
}

export function open() {
  tools().openPanelDialog("RefPacks", draw);
  load().then(redraw).catch((error) => tools().toast(error.message, true));
}
