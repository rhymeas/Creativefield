/* Browser downloads for the artefacts this workspace makes: a still of the
 * current frame and the score itself. Programmatic anchors only; JSX stays on
 * the design system. */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadText(text: string, filename: string, type = "text/yaml") {
  downloadBlob(new Blob([text], {type}), filename);
}
