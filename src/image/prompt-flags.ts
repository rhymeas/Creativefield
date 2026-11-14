/** Midjourney and Stable Diffusion trailing flags are not language; H3 and our other image models
 * read the prompt as a caption, so a flag like "--ar 3:4 --stylize 300 --v 6" only adds noise.
 * Known flags and their single value are removed; anything else is left as typed. */
const FLAGS = new Set([
  "ar", "aspect", "v", "niji", "stylize", "s", "style", "style_raw", "style_reference", "chaos", "seed",
  "quality", "q", "no", "stop", "repeat", "tile", "weird", "iw", "cref", "sref", "c", "w", "h", "raw",
]);

export function stripModelParameters(prompt: string): string {
  return prompt
    .replace(/(^|\s)--([a-z][a-z0-9_]*)(?:\s+([^\s-][^\s]*))?/gi, (match, lead: string, flag: string) => (
      FLAGS.has(flag.toLowerCase()) ? lead : match
    ))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}
