/** Plain titles for generated and uploaded files, so pickers read "Swapped person 8", not "scail2-character-replace_00008_.mp4". */
const KNOWN: Array<[RegExp, string]> = [
  [/^scail2-character-replace/i, "Swapped person"],
  [/^vace-(canny|depth)-restyle/i, "New look"],
  [/^vace-reference-restyle/i, "New look from a picture"],
  [/^masked-edit/i, "Edited area"],
  [/^wan2?\.?2?_?i2v|^wan22-i2v|^wan2\.2_i2v/i, "Photo to video"],
  [/^wan.*t2v/i, "Video from words"],
  [/^wan.*animate|^motion/i, "Copied moves"],
  [/^storyboard-/i, "Storyboard film"],
  [/^flux2?-klein-t2i|^flux.*t2i|^qwen.*t2i/i, "Picture from words"],
  [/^flux2?-klein.*edit|^qwen.*edit/i, "Edited picture"],
  [/^true-angle/i, "Angle view"],
  [/^comfyfield-trellis|trellis/i, "3D model"],
  [/^comfyfield-tts|chatterbox|speech/i, "Voice"],
  [/^ComfyUI_/i, "ComfyUI result"],
];

/** The exported film's own file name: "Robot chase-rev3.mp4", not "storyboard-<uuid>.mp4". */
export function filmName(title: string|null|undefined,revision: number): string {
  const words=(title??"").replace(/[<>:"/\\|?*\u0000-\u001f]+/g," ").replace(/\s+/g," ").trim().replace(/[. ]+$/,"");
  // Short enough for a file dialog and for Windows' path limit.
  const base=[...words].slice(0,80).join("").trim().replace(/[. ]+$/,"")||"Storyboard film";
  return `${base}-rev${revision}.mp4`;
}

export function friendlyMediaName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "");
  // Files the app uploaded to the worker carry ids only.
  if (/^comfyfield-[0-9a-f-]{20,}/i.test(base)) return "Uploaded file";
  // ComfyUI counters look like _00008_; a trailing id is not a take number.
  const take = /_0*(\d{1,5})_?$/.exec(base)?.[1];
  const known = KNOWN.find(([pattern]) => pattern.test(base))?.[1];
  if (known) return take ? `${known} ${take}` : known;
  // Someone's own file: keep their words, without separators and counters.
  const words = base.replace(/[_-]+0*\d*_?$/, "").replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}
