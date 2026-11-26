/* CreativeField Film Studio additions, inserted after h3-editor-embed.js by scripts/install-h3-editor.ps1.
   - Grade (project menu): a look LUT (.cube) with its strength, exposure, contrast, saturation, warmth, grain and the soft finish for the
     whole cut; match every clip to one reference shot; a before/after still of the frame under the playhead, because the
     live preview does not show the grade (the export does).
   - Export dialog: "For Resolve / Premiere" downloads an editable FCP 7 XML package (media, sounds, LUTs).
   Built only from the editor's own markup (dialog.keys.exporter, label.field, .strength sliders, .choice, quiet/primary
   buttons), so the #ds theme styles it. The API is scripts/h3-editor-cf (cf_grade.py, cf_api.py, cf_nle.py). */
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.get("cf_project")) return;
  const folder = params.get("project");
  const base = (location.pathname.match(/^\/h3-editor\/[0-9a-f-]{36}/i) || [""])[0];
  const api = async (path, body, form) => {
    const options = form ? {method: "POST", body: form}
      : body === undefined ? {} : {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)};
    const reply = await fetch(`${base}/h3take/api/project/${encodeURIComponent(folder)}${path}`, options);
    const data = await reply.json().catch(() => ({}));
    if (!reply.ok || data.error) throw new Error(data.error || reply.statusText);
    return data;
  };
  const view = (asset, fresh) => `${base}/view?type=output&filename=${encodeURIComponent(asset.file)}&subfolder=${encodeURIComponent(asset.subfolder || "")}${fresh ? "&t=" + Date.now() : ""}`;
  const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const field = (label, control) => { const row = make("label", "field"); row.append(make("span", "", label), control); return row; };
  const FPS = 24;
  const frameNow = () => { const [m, s, f] = (document.getElementById("time")?.textContent || "0:0:0").split(":").map(Number); return ((m || 0) * 60 + (s || 0)) * FPS + (f || 0); };
  const download = asset => { const link = make("a"); link.href = view(asset); link.download = asset.file; document.body.append(link); link.click(); link.remove(); };

  // A slider in the editor's own markup: a range and a number that follow each other.
  const slider = (label, [min, max], usual, step = 0.05) => {
    const wrap = make("div", "strength"), range = make("input"), amount = make("input", "amount");
    range.type = "range"; amount.type = "number";
    for (const input of [range, amount]) Object.assign(input, {min, max, step});
    range.setAttribute("aria-label", label); amount.setAttribute("aria-label", label + ", as a number");
    range.title = "Double-click for " + usual;
    const at = x => (Math.min(max, Math.max(min, x)) - min) / (max - min);
    const set = v => {
      v = Math.round(Math.min(max, Math.max(min, Number(v) || 0)) * 100) / 100;
      range.value = v; amount.value = v.toFixed(2);
      range.style.setProperty("--from", Math.min(at(usual), at(v))); range.style.setProperty("--to", Math.max(at(usual), at(v)));
    };
    range.addEventListener("input", () => set(range.value));
    amount.addEventListener("change", () => set(amount.value));
    range.addEventListener("dblclick", () => set(usual));
    wrap.append(range, amount); set(usual);
    return {row: field(label, wrap), get: () => Number(amount.value), set};
  };

  const ready = () => {
    if (document.getElementById("cfGrade")) return;
    const dialog = make("dialog", "keys exporter"); dialog.id = "cfGrade"; dialog.setAttribute("aria-labelledby", "cfGradeTitle");
    const head = make("div", "keys-head"), title = make("h2", "", "Grade"), close = make("button", "quiet", "Close");
    title.id = "cfGradeTitle"; head.append(title, close);
    const body = make("div", "exporter-body"), foot = make("div", "exporter-foot");
    const sliders = {
      look_strength: slider("Look strength", [0, 1], 1), exposure: slider("Exposure, stops", [-1.5, 1.5], 0),
      contrast: slider("Contrast", [0.5, 1.5], 1), saturation: slider("Saturation", [0, 2], 1),
      warmth: slider("Warmth", [-1, 1], 0), grain: slider("Grain", [0, 1], 0),
      soft: slider("Soft finish", [0, 0.3], 0.1, 0.01),  // denoise, a faint mist, a subtle sharpen; 0 is off (cf_grade.SOFT_DEFAULT)
    };
    let look = null;
    const lutFile = make("input"); lutFile.type = "file"; lutFile.accept = ".cube";
    const lutName = make("p", "hint", "No look LUT"), lutRemove = make("button", "quiet", "Remove LUT"); lutRemove.type = "button";
    const showLook = () => { lutName.textContent = look ? "Look: " + (look.name || look.file) : "No look LUT"; lutRemove.hidden = !look; };
    const reference = make("select"), matchStrength = slider("Match strength", [0, 1], 0.8);
    const referenceRow = make("label", "choice"); referenceRow.append(make("span", "", "Reference shot"), reference);
    const matchGo = make("button", "quiet", "Match all clips to it"), matchOff = make("button", "quiet", "Turn off the match");
    const matchRow = make("div", "halves"); matchGo.type = matchOff.type = "button"; matchRow.append(matchGo, matchOff);
    const previewGo = make("button", "quiet", "Show the frame under the playhead"); previewGo.type = "button";
    const before = make("img"), after = make("img"), pictures = make("div", "halves");
    for (const [img, alt] of [[before, "Before the grade"], [after, "After the grade"]]) { img.alt = alt; img.hidden = true; img.style.width = "100%"; }
    pictures.append(before, after);
    const result = make("p", "hint"); result.setAttribute("aria-live", "polite");
    const apply = make("button", "primary", "Apply");
    body.append(make("p", "exporter-summary", "Colour for the whole cut. The export and the still below show it; the live preview does not."),
      field("Look LUT, a .cube file", lutFile), lutName, lutRemove, ...Object.values(sliders).map(s => s.row),
      make("p", "exporter-summary", "Match every clip's colours and values to one shot. Each clip gets its own correction."),
      referenceRow, matchStrength.row, matchRow, previewGo, pictures, result);
    foot.append(make("span", "spacer"), apply);
    dialog.append(head, body, foot);
    document.body.append(dialog);

    const fields = () => Object.assign({look: look && {file: look.file, subfolder: look.subfolder, name: look.name}},
      ...Object.entries(sliders).map(([key, s]) => ({[key]: s.get()})));
    const say = text => { result.textContent = text; };
    const busy = async (button, text, work) => {
      button.disabled = true; say(text);
      try { await work(); } catch (error) { say(String(error.message || error)); } finally { button.disabled = false; }
    };
    const open = async () => {
      say("");
      const project = await api("");
      const grade = project.grade || {};
      look = grade.look || null; showLook();
      for (const [key, s] of Object.entries(sliders)) if (typeof grade[key] === "number") s.set(grade[key]);
      const clips = Object.fromEntries((project.clips || []).map(c => [c.id, c]));
      const seen = new Set();
      reference.replaceChildren(...(project.timeline || []).slice().sort((a, b) => a.start - b.start)
        .filter(item => !seen.has(item.clip) && seen.add(item.clip))
        .map(item => { const option = make("option", "", `${clips[item.clip]?.name || item.clip}, ${(item.start / FPS).toFixed(1)} s`); option.value = item.clip; return option; }));
      if (grade.match) { reference.value = grade.match.reference; matchStrength.set(grade.match.strength); }
      matchOff.hidden = !grade.match;
      dialog.showModal();
    };
    close.addEventListener("click", () => dialog.close());
    lutFile.addEventListener("change", () => busy(apply, "Uploading the LUT", async () => {
      const form = new FormData(); form.append("file", lutFile.files[0]);
      look = await api("/lut", undefined, form); showLook(); say("The LUT is loaded. Apply to use it.");
      lutFile.value = "";
    }));
    lutRemove.addEventListener("click", () => { look = null; showLook(); say("Apply to remove the LUT from the cut."); });
    apply.addEventListener("click", () => busy(apply, "Applying", async () => {
      await api("/ops", {ops: [{op: "set_grade", fields: fields()}]});
      say("Applied. The next export carries the grade.");
    }));
    matchGo.addEventListener("click", () => busy(matchGo, "Measuring every clip; this takes a few seconds per ten clips", async () => {
      const done = await api("/match_grade", {reference: reference.value, strength: matchStrength.get()});
      matchOff.hidden = false;
      say(`Matched ${done.matched} clips to the reference.` + (done.skipped ? ` ${done.skipped} could not be read and keep their colours.` : ""));
    }));
    matchOff.addEventListener("click", () => busy(matchOff, "Turning the match off", async () => {
      await api("/ops", {ops: [{op: "set_grade", fields: {match: null}}]}); matchOff.hidden = true; say("The clips keep their own colours again.");
    }));
    previewGo.addEventListener("click", () => busy(previewGo, "Grading the frame", async () => {
      const shot = await api("/grade_preview", {frame: frameNow(), grade: fields()});
      before.src = view(shot.before, true); after.src = view(shot.after, true); before.hidden = after.hidden = false;
      say(`${shot.name}: before on the left, after on the right.`);
    }));

    // Project menu: Grade, in the editor's own menu item markup (title, description as tooltip).
    const menu = document.getElementById("projectMenu");
    if (menu && !menu.querySelector("[data-cf-grade]")) {
      const item = make("button"); item.type = "button"; item.setAttribute("role", "menuitem"); item.dataset.cfGrade = "1"; item.dataset.cfItem = "1";
      item.append(make("b", "", "Grade"), make("span", "", "Look LUT, colour, grain, and matching every clip to one shot"));
      item.title = "Look LUT, colour, grain, and matching every clip to one shot";
      item.addEventListener("click", () => { try { menu.hidePopover(); } catch { /* closed */ } open().catch(error => alert(error.message)); });
      menu.insertBefore(item, menu.firstElementChild);
    }

    // Export dialog: an editable package for DaVinci Resolve and Premiere Pro beside the video export.
    const exporterFoot = document.querySelector("#exporter .exporter-foot");
    if (exporterFoot && !exporterFoot.querySelector("[data-cf-nle]")) {
      const nle = make("button", "quiet", "For Resolve / Premiere"); nle.type = "button"; nle.dataset.cfNle = "1";
      nle.title = "An editable timeline (FCP 7 XML) with its media, sounds and the clips' grading LUTs, as a zip";
      const note = document.getElementById("exporterResult");
      nle.addEventListener("click", async () => {
        nle.disabled = true; if (note) note.textContent = "Packing the timeline for DaVinci Resolve and Premiere Pro";
        try {
          const name = document.getElementById("exporterName")?.value?.trim();
          const done = await api("/export_nle", name ? {name} : {});
          if (note) note.textContent = `Ready: ${done.clips} clips, ${done.sounds} sounds. Open the XML inside the zip in Resolve (File > Import > Timeline) or Premiere (File > Import).`;
          download(done.zip);
        } catch (error) { if (note) note.textContent = String(error.message || error); } finally { nle.disabled = false; }
      });
      exporterFoot.insertBefore(nle, exporterFoot.querySelector(".spacer"));
    }
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready); else ready();
})();
